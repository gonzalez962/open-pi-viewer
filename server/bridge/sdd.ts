import fs from 'node:fs';
import path from 'node:path';
import { PI_AGENT_DIR, getActiveCwd } from './state';

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
}

/**
 * Scan all markdown agent definitions from ~/.pi/agent/agents and gentle-pi assets
 */
export function discoverAgentDefinitions(): Record<string, { id: string; name: string; description: string; tools: string[]; category?: string }> {
  const agentMap: Record<string, { id: string; name: string; description: string; tools: string[]; category?: string }> = {};
  const activeCwd = getActiveCwd();

  const dirsToScan = [
    path.join(PI_AGENT_DIR, 'agents'),
    path.join(PI_AGENT_DIR, 'npm', 'node_modules', 'gentle-pi', 'assets', 'agents'),
    path.join(activeCwd, '.pi', 'agents'),
    path.join(activeCwd, 'agents'),
  ];

  for (const dir of dirsToScan) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of entries) {
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const trimmed = content.trim();
        let frontmatter = '';
        if (trimmed.startsWith('---')) {
          const after = trimmed.slice(3);
          const endIdx = after.indexOf('\n---');
          if (endIdx !== -1) {
            frontmatter = after.slice(0, endIdx);
          }
        }

        const agentId = f.replace(/\.md$/, '');
        let name = agentId;
        let description = '';
        let tools: string[] = [];

        if (frontmatter) {
          const nameMatch = frontmatter.match(/name:\s*([^\n\r]+)/);
          if (nameMatch) name = nameMatch[1].trim();

          const descMatch = frontmatter.match(/description:\s*([^\n\r]+)/);
          if (descMatch) description = descMatch[1].trim();

          const toolsMatch = frontmatter.match(/tools:\s*([^\n\r]+)/);
          if (toolsMatch) {
            tools = toolsMatch[1].split(',').map((t) => t.trim().replace(/^['"\s]+|['"\s]+$/g, '')).filter(Boolean);
          } else {
            // Check list format
            const listMatch = frontmatter.match(/tools:\s*\n((?:\s*-\s*[^\n\r]+\n?)+)/);
            if (listMatch) {
              tools = listMatch[1]
                .split('\n')
                .map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
            }
          }
        }

        if (!description) {
          description = `Subagente ${name}`;
        }

        agentMap[agentId] = {
          id: agentId,
          name,
          description,
          tools,
        };
      } catch {}
    }
  }

  return agentMap;
}

export function getSddProfilesImpl(cwd?: string) {
  const profilesDir = path.join(PI_AGENT_DIR, 'profiles');
  const projectProfilesDir = cwd ? path.join(cwd, '.pi', 'profiles') : null;

  const rawProfiles: { profile: any; scope: 'global' | 'project'; filePath: string }[] = [];

  if (fs.existsSync(profilesDir)) {
    const files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    for (const f of files) {
      try {
        const fullPath = path.join(profilesDir, f);
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (data && data.name) {
          rawProfiles.push({ profile: data, scope: 'global', filePath: fullPath });
        }
      } catch {}
    }
  }

  if (projectProfilesDir && fs.existsSync(projectProfilesDir)) {
    const files = fs.readdirSync(projectProfilesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    for (const f of files) {
      try {
        const fullPath = path.join(projectProfilesDir, f);
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (data && data.name) {
          rawProfiles.push({ profile: data, scope: 'project', filePath: fullPath });
        }
      } catch {}
    }
  }

  let globalActive: string | null = null;
  const activeFile = path.join(profilesDir, '.active');
  if (fs.existsSync(activeFile)) {
    const txt = fs.readFileSync(activeFile, 'utf8').trim();
    if (txt) globalActive = txt;
  }

  let projectActive: string | null = null;
  if (projectProfilesDir) {
    const pActiveFile = path.join(projectProfilesDir, '.active');
    if (fs.existsSync(pActiveFile)) {
      const txt = fs.readFileSync(pActiveFile, 'utf8').trim();
      if (txt) projectActive = txt;
    }
  }

  const effectiveActive = projectActive || globalActive;
  const effectiveScope = projectActive ? 'project' : globalActive ? 'global' : null;

  const profiles = rawProfiles.map(({ profile, scope, filePath }) => {
    const isAct = effectiveActive && profile.name.toLowerCase() === effectiveActive.toLowerCase();
    const modelProfiles = profile.model_profiles || {};
    const agentCount = Object.keys(modelProfiles).length;

    return {
      name: profile.name,
      description: profile.description || '',
      default_model: profile.default_model || '',
      default_effort: profile.default_effort || 'high',
      agent_count: agentCount,
      scope,
      is_active: Boolean(isAct),
      active_scope: isAct ? effectiveScope : undefined,
      path: filePath,
      model_profiles: modelProfiles,
    };
  });

  const agentMeta = discoverAgentDefinitions();
  const agentSet = new Set<string>(Object.keys(agentMeta));

  const subagentsFile = path.join(PI_AGENT_DIR, 'subagents.json');
  if (fs.existsSync(subagentsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(subagentsFile, 'utf8'));
      if (parsed.model_profiles) {
        for (const k of Object.keys(parsed.model_profiles)) {
          agentSet.add(k);
        }
      }
    } catch {}
  }

  for (const { profile } of rawProfiles) {
    if (profile.model_profiles) {
      for (const k of Object.keys(profile.model_profiles)) {
        agentSet.add(k);
      }
    }
  }

  const allAgents = Array.from(agentSet).sort();

  const catMap = new Map<string, { id: string; name: string; description: string; priority: number; agents: string[] }>();

  function getBucket(id: string, name: string, description: string, priority: number) {
    if (!catMap.has(id)) {
      catMap.set(id, { id, name, description, priority, agents: [] });
    }
    return catMap.get(id)!;
  }

  for (const agentId of allAgents) {
    if (agentId.startsWith('sdd-')) {
      getBucket('sdd-core', 'Spec-Driven Development', 'SDD phase executor agents', 10).agents.push(agentId);
    } else if (agentId.startsWith('jd-')) {
      getBucket('judgment-day', 'Judgment Day', 'Blind dual review judges and fix agent', 20).agents.push(agentId);
    } else if (agentId.startsWith('review-') || agentId.endsWith('-auditor')) {
      getBucket('reviewers', 'Reviewers & Auditors', 'Quality, security, and architectural review lenses', 30).agents.push(agentId);
    } else if (agentId.startsWith('gentle-ai-') || agentId.startsWith('gentle-')) {
      getBucket('gentle-ai', 'Gentle AI', 'Gentle AI harness and execution agents', 40).agents.push(agentId);
    } else {
      getBucket('general', 'General Harness', 'Subagents for general workflows and tasks', 90).agents.push(agentId);
    }
  }

  const categories = Array.from(catMap.values())
    .sort((a, b) => a.priority - b.priority)
    .map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      agents: b.agents.sort(),
    }));

  return {
    profiles,
    projectActiveProfile: projectActive,
    globalActiveProfile: globalActive,
    effectiveActiveProfile: effectiveActive,
    effectiveScope: effectiveScope,
    categories,
    allAgents,
    agentMeta,
  };
}

export function setActiveSddProfileImpl(name: string | null, scope: 'project' | 'global' = 'global', cwd?: string) {
  const dir = scope === 'project' && cwd ? path.join(cwd, '.pi', 'profiles') : path.join(PI_AGENT_DIR, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const activeFile = path.join(dir, '.active');

  if (!name) {
    if (fs.existsSync(activeFile)) fs.unlinkSync(activeFile);
    return { success: true, message: 'Active profile cleared' };
  }

  fs.writeFileSync(activeFile, name.trim() + '\n', 'utf8');

  const profileFile = path.join(dir, `${slugify(name)}.json`);
  let profileData: any = null;
  if (fs.existsSync(profileFile)) {
    profileData = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  } else {
    const gFile = path.join(PI_AGENT_DIR, 'profiles', `${slugify(name)}.json`);
    if (fs.existsSync(gFile)) {
      profileData = JSON.parse(fs.readFileSync(gFile, 'utf8'));
    }
  }

  if (profileData && profileData.model_profiles) {
    const subagentsPath = scope === 'project' && cwd ? path.join(cwd, '.pi', 'subagents.json') : path.join(PI_AGENT_DIR, 'subagents.json');
    let subagentsObj: any = {};
    if (fs.existsSync(subagentsPath)) {
      try {
        subagentsObj = JSON.parse(fs.readFileSync(subagentsPath, 'utf8'));
      } catch {}
    }
    subagentsObj.model_profiles = profileData.model_profiles;
    fs.writeFileSync(subagentsPath, JSON.stringify(subagentsObj, null, 2) + '\n', 'utf8');
  }

  return { success: true, message: `Profile '${name}' activated successfully` };
}

// ---------------------------------------------------------------------------
// Chains / Cadenas de Ejecución (Opción 5)
// ---------------------------------------------------------------------------

export interface PiChainStep {
  name: string;
  output?: string;
  reads?: string;
  description?: string;
}

export interface PiChain {
  name: string;
  description: string;
  path: string;
  steps: PiChainStep[];
}

export function discoverPiChains(): PiChain[] {
  const chains: PiChain[] = [];
  const dirs = [
    path.join(PI_AGENT_DIR, 'chains'),
    path.join(PI_AGENT_DIR, 'npm', 'node_modules', 'gentle-pi', 'assets', 'chains'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.chain.md'));
    for (const f of entries) {
      try {
        const fullPath = path.join(dir, f);
        const content = fs.readFileSync(fullPath, 'utf8');
        const trimmed = content.trim();

        let frontmatter = '';
        if (trimmed.startsWith('---')) {
          const after = trimmed.slice(3);
          const endIdx = after.indexOf('\n---');
          if (endIdx !== -1) {
            frontmatter = after.slice(0, endIdx);
          }
        }

        let name = f.replace(/\.chain\.md$/, '');
        let description = '';

        if (frontmatter) {
          const nameMatch = frontmatter.match(/name:\s*([^\n\r]+)/);
          if (nameMatch) name = nameMatch[1].trim();

          const descMatch = frontmatter.match(/description:\s*([^\n\r]+)/);
          if (descMatch) description = descMatch[1].trim();
        }

        // Parse steps (## <step>)
        const steps: PiChainStep[] = [];
        const sections = content.split(/\n##\s+/);
        for (let i = 1; i < sections.length; i++) {
          const sec = sections[i];
          const lines = sec.split('\n');
          const stepName = lines[0].trim();
          if (stepName.toLowerCase().includes('guard') || stepName.toLowerCase().includes('transport')) {
            continue; // Skip guards
          }
          const outputMatch = sec.match(/output:\s*([^\n\r]+)/);
          const readsMatch = sec.match(/reads:\s*([^\n\r]+)/);
          const stepDesc = lines.slice(1).filter((l) => !l.includes(':')).join(' ').trim();

          steps.push({
            name: stepName,
            output: outputMatch ? outputMatch[1].trim() : undefined,
            reads: readsMatch ? readsMatch[1].trim() : undefined,
            description: stepDesc.slice(0, 140),
          });
        }

        // Avoid duplicate by name
        if (!chains.some((c) => c.name === name)) {
          chains.push({
            name,
            description,
            path: fullPath,
            steps,
          });
        }
      } catch {}
    }
  }

  return chains;
}

export function handleGetSddProfiles(args: any = {}) {
  const cwd = args.cwd || getActiveCwd();
  return getSddProfilesImpl(cwd);
}

export function handleSetActiveSddProfile(args: any = {}) {
  return setActiveSddProfileImpl(args.name, args.scope || 'global', args.cwd || getActiveCwd());
}

export function handleSaveSddProfile(args: any = {}) {
  const profile = args.profile;
  if (!profile || !profile.name) {
    throw new Error('Profile name is required');
  }
  const dir = args.scope === 'project' ? path.join(args.cwd || getActiveCwd(), '.pi', 'profiles') : path.join(PI_AGENT_DIR, 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const profilePath = path.join(dir, `${slugify(profile.name)}.json`);
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  return { success: true, profile, path: profilePath, message: `Profile '${profile.name}' saved` };
}

export function handleDeleteSddProfile(args: any = {}) {
  const name = args.name;
  const dir = args.scope === 'project' ? path.join(args.cwd || getActiveCwd(), '.pi', 'profiles') : path.join(PI_AGENT_DIR, 'profiles');
  const profilePath = path.join(dir, `${slugify(name)}.json`);
  if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
  const actFile = path.join(dir, '.active');
  if (fs.existsSync(actFile) && fs.readFileSync(actFile, 'utf8').trim() === name) {
    fs.unlinkSync(actFile);
  }
  return { success: true, message: `Profile '${name}' deleted` };
}

export function handleGetPiChains() {
  return discoverPiChains();
}
