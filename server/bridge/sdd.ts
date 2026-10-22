import fs from 'node:fs';
import path from 'node:path';
import { PI_AGENT_DIR, getActiveCwd } from './state';
import { generateProfileId } from '../../src/core/types/profiles';

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'general';
}

export function normalizeCwdKey(dir: string): string {
  try {
    return path.resolve(dir).replace(/\\/g, '/').toLowerCase();
  } catch {
    return dir.replace(/\\/g, '/').toLowerCase();
  }
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
        if (data && typeof data === 'object') {
          const stem = f.replace(/\.json$/, '');
          const id = (data.id && typeof data.id === 'string' && data.id.trim()) ? data.id.trim() : stem;
          const name = (data.name && typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : id;
          data.id = id;
          data.name = name;
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
        if (data && typeof data === 'object') {
          const stem = f.replace(/\.json$/, '');
          const id = (data.id && typeof data.id === 'string' && data.id.trim()) ? data.id.trim() : stem;
          const name = (data.name && typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : id;
          data.id = id;
          data.name = name;
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
  const projectsActiveFile = path.join(profilesDir, 'projects-active.json');
  if (fs.existsSync(projectsActiveFile) && cwd) {
    try {
      const map = JSON.parse(fs.readFileSync(projectsActiveFile, 'utf8'));
      const normalizedCwd = normalizeCwdKey(cwd);
      for (const [k, v] of Object.entries(map)) {
        if (normalizeCwdKey(k) === normalizedCwd && typeof v === 'string') {
          projectActive = v.trim();
          break;
        }
      }
    } catch {}
  }
  if (!projectActive && projectProfilesDir) {
    const pActiveFile = path.join(projectProfilesDir, '.active');
    if (fs.existsSync(pActiveFile)) {
      const txt = fs.readFileSync(pActiveFile, 'utf8').trim();
      if (txt) projectActive = txt;
    }
  }

  const effectiveActive = projectActive || globalActive;
  const effectiveScope = projectActive ? 'project' : globalActive ? 'global' : null;

  const profiles = rawProfiles.map(({ profile, scope: _scope, filePath }) => {
    const isAct = effectiveActive && (
      (profile.id && profile.id.toLowerCase() === effectiveActive.toLowerCase()) ||
      (profile.name && profile.name.toLowerCase() === effectiveActive.toLowerCase()) ||
      (slugify(profile.name) === slugify(effectiveActive))
    );
    const modelProfiles = profile.model_profiles || {};
    const agentCount = Object.keys(modelProfiles).length;

    return {
      id: profile.id,
      name: profile.name,
      description: profile.description || '',
      default_model: profile.default_model || '',
      default_effort: profile.default_effort || 'high',
      agent_count: agentCount,
      scope: 'global' as const,
      is_active: Boolean(isAct),
      active_scope: isAct ? effectiveScope : undefined,
      path: filePath,
      model_profiles: modelProfiles,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
    };
  });

  const activeProfile = profiles.find((p) => p.is_active);
  const resolvedEffectiveActive = activeProfile ? activeProfile.name : effectiveActive;

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
    effectiveActiveProfile: resolvedEffectiveActive,
    effectiveScope: effectiveScope,
    categories,
    allAgents,
    agentMeta,
  };
}

export function setActiveSddProfileImpl(name: string | null, scope: 'project' | 'global' = 'global', cwd?: string) {
  const globalProfilesDir = path.join(PI_AGENT_DIR, 'profiles');
  fs.mkdirSync(globalProfilesDir, { recursive: true });

  if (scope === 'project') {
    const mapFile = path.join(globalProfilesDir, 'projects-active.json');
    let map: Record<string, string> = {};
    if (fs.existsSync(mapFile)) {
      try {
        map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      } catch {}
    }
    const cleanCwd = cwd || getActiveCwd();
    const normalizedKey = normalizeCwdKey(cleanCwd);
    if (!name) {
      for (const k of Object.keys(map)) {
        if (normalizeCwdKey(k) === normalizedKey || k === cleanCwd) {
          delete map[k];
        }
      }
      fs.writeFileSync(mapFile, JSON.stringify(map, null, 2) + '\n', 'utf8');
      return { success: true, message: 'Project active profile cleared' };
    }
    for (const k of Object.keys(map)) {
      if (normalizeCwdKey(k) === normalizedKey) {
        delete map[k];
      }
    }
    map[cleanCwd] = name.trim();
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2) + '\n', 'utf8');
    return { success: true, message: `Profile '${name}' activated for project` };
  }

  const activeFile = path.join(globalProfilesDir, '.active');
  if (!name) {
    if (fs.existsSync(activeFile)) fs.unlinkSync(activeFile);
    return { success: true, message: 'Global active profile cleared' };
  }

  fs.writeFileSync(activeFile, name.trim() + '\n', 'utf8');
  return { success: true, message: `Profile '${name}' activated globally` };
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
  if (!profile || !profile.name || typeof profile.name !== 'string' || !profile.name.trim()) {
    throw new Error('Profile name is required and cannot be empty');
  }
  const cleanName = profile.name.trim();
  const dir = path.join(PI_AGENT_DIR, 'profiles');
  fs.mkdirSync(dir, { recursive: true });

  const id = (profile.id && typeof profile.id === 'string' && profile.id.trim())
    ? profile.id.trim()
    : generateProfileId();

  const now = new Date().toISOString();
  profile.id = id;
  profile.name = cleanName;
  if (!profile.created_at) {
    profile.created_at = now;
  }
  profile.updated_at = now;

  const profilePath = path.join(dir, `${id}.json`);
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n', 'utf8');
  return { success: true, profile, path: profilePath, message: `Profile '${cleanName}' saved` };
}

export function handleDeleteSddProfile(args: any = {}) {
  const rawName = args.name || args.payload?.name || (typeof args === 'string' ? args : '');
  if (!rawName || typeof rawName !== 'string' || !rawName.trim()) {
    throw new Error('Profile name or ID is required');
  }
  const trimmed = rawName.trim().replace(/\.json$/, '');
  const globalDir = path.join(PI_AGENT_DIR, 'profiles');
  const searchDirs = [globalDir];
  const cwd = args.cwd || args.payload?.cwd || getActiveCwd();
  if (cwd) {
    const projDir = path.join(cwd, '.pi', 'profiles');
    if (fs.existsSync(projDir) && !searchDirs.includes(projDir)) {
      searchDirs.push(projDir);
    }
  }

  let deletedId: string | null = null;
  let deletedName: string | null = null;
  let fileToDelete: string | null = null;

  for (const dir of searchDirs) {
    const directIdPath = path.join(dir, `${trimmed}.json`);
    const directSlugPath = path.join(dir, `${slugify(trimmed)}.json`);

    if (fs.existsSync(directIdPath)) {
      fileToDelete = directIdPath;
      try {
        const data = JSON.parse(fs.readFileSync(directIdPath, 'utf8'));
        deletedId = data.id || null;
        deletedName = data.name || null;
      } catch {}
      break;
    } else if (fs.existsSync(directSlugPath)) {
      fileToDelete = directSlugPath;
      try {
        const data = JSON.parse(fs.readFileSync(directSlugPath, 'utf8'));
        deletedId = data.id || null;
        deletedName = data.name || null;
      } catch {}
      break;
    } else if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
      for (const f of files) {
        try {
          const fullPath = path.join(dir, f);
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          const stem = f.replace(/\.json$/, '');
          if (
            (data.id && data.id === trimmed) ||
            (data.name && data.name === trimmed) ||
            slugify(data.name || '') === slugify(trimmed) ||
            stem === trimmed
          ) {
            fileToDelete = fullPath;
            deletedId = data.id || null;
            deletedName = data.name || null;
            break;
          }
        } catch {}
      }
      if (fileToDelete) break;
    }
  }

  if (fileToDelete && fs.existsSync(fileToDelete)) {
    fs.unlinkSync(fileToDelete);
  }

  const targetId = deletedId || trimmed;
  const targetName = deletedName || trimmed;
  const targetSlug = slugify(targetName);

  for (const dir of searchDirs) {
    const actFile = path.join(dir, '.active');
    if (fs.existsSync(actFile)) {
      const activeVal = fs.readFileSync(actFile, 'utf8').trim();
      if (activeVal === targetId || activeVal === targetName || slugify(activeVal) === targetSlug || activeVal === trimmed) {
        fs.unlinkSync(actFile);
      }
    }
  }

  const mapFile = path.join(globalDir, 'projects-active.json');
  if (fs.existsSync(mapFile)) {
    try {
      const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      for (const k of Object.keys(map)) {
        const val = map[k];
        if (val === targetId || val === targetName || slugify(val) === targetSlug || val === trimmed) {
          delete map[k];
        }
      }
      fs.writeFileSync(mapFile, JSON.stringify(map, null, 2) + '\n', 'utf8');
    } catch {}
  }

  return { success: true, message: `Profile '${trimmed}' deleted` };
}

export function handleGetPiChains() {
  return discoverPiChains();
}
