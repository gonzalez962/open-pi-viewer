import React, { useState, useMemo } from 'react';
import type { TranslationKey } from '@shared/i18n';
import type {
  ProcessCategory,
  ProcessGroup,
} from '@core/process-grouping';
import { getCategoryDetails, extractDiscoveredSubagents, getOddAgentType } from '../process-utils';
import { ThinkingCard, ToolCard } from '../ActivityBlocks';

export interface ProcessGroupCardProps {
  group: ProcessGroup;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/**
 * ProcessGroupCard represents a compacted sequence of agent processes and tool calls.
 * Allows expanding/compacting per category with '+' and '-', as well as a general toggle.
 */
export const ProcessGroupCard: React.FC<ProcessGroupCardProps> = React.memo(({ group, t }) => {
  // Set of category IDs that are expanded
  const [expandedCategories, setExpandedCategories] = useState<Set<ProcessCategory>>(() => new Set());

  const categories = group.categoriesPresent;
  const subagentsInGroup = useMemo(
    () => extractDiscoveredSubagents(group.items, { includeOrchestrator: true }),
    [group.items]
  );

  // Determine if all categories are currently expanded
  const allExpanded = useMemo(() => {
    if (categories.length === 0) return false;
    return categories.every((cat) => expandedCategories.has(cat));
  }, [categories, expandedCategories]);

  // General toggle handler: expands all if not all expanded, collapses all otherwise
  const handleToggleGeneral = () => {
    if (allExpanded) {
      setExpandedCategories(new Set());
    } else {
      setExpandedCategories(new Set(categories));
    }
  };

  // Per-category toggle handler
  const handleToggleCategory = (category: ProcessCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const errorCount = useMemo(() => {
    return group.items.filter(
      (i) => i.block.type === 'tool_call' && (i.block.status === 'error' || i.block.isError)
    ).length;
  }, [group.items]);

  const statusBadge = group.hasRunning
    ? t('activity.tool_status_running')
    : group.hasErrors
      ? (errorCount === group.totalCount
          ? t('process.status_error')
          : t('process.status_with_warnings'))
      : t('activity.tool_status_completed');

  const statusClass = group.hasRunning
    ? 'status-running'
    : group.hasErrors
      ? 'status-error'
      : 'status-completed';

  const totalBadge =
    group.totalCount === 1
      ? t('process.total_process_one')
      : t('process.total_processes', { count: group.totalCount });

  return (
    <div className={`process-group-card ${statusClass}`}>
      {/* General Header */}
      <div className="process-group-header">
        <div className="process-group-header-left">
          {/* Visible Glowing Incandescent Agent Labels: Orquestador, Explorer, Verify, Task */}
          {subagentsInGroup.length > 0 && (
            <div className="process-group-header-odd-agents">
              {subagentsInGroup.map((agent) => {
                const agentType = agent.type || getOddAgentType(agent.name);
                const isWorking = agent.status === 'running';
                const labelText = agent.displayName || agent.name;
                return (
                  <span
                    key={agent.name}
                    className={`odd-agent-oval agent-${agentType} ${isWorking ? 'is-running' : ''}`}
                    title={`${agent.name} (${agent.status})`}
                  >
                    <span className="odd-agent-dot" aria-hidden="true" />
                    <strong className="odd-agent-name">{labelText}</strong>
                  </span>
                );
              })}
            </div>
          )}

          {/* Compact Status Pill */}
          <span className={`process-group-status-pill ${statusClass}`}>
            {statusBadge}
          </span>

          {/* Compact Category Badges */}
          <div className="process-group-category-badges">
            {categories.map((cat) => {
              const count = group.byCategory[cat]?.length || 0;
              const details = getCategoryDetails(cat, count, t);
              return (
                <span key={cat} className="category-pill-badge" title={`${details.label}: ${count}`}>
                  <span className="category-pill-glyph" aria-hidden="true">{details.glyph}</span>
                  <span>{details.label}</span>
                  <span className="category-pill-count">{count}</span>
                </span>
              );
            })}
          </div>

          {/* Subtle info for screen readers / test parity */}
          <span className="process-group-summary-meta">
            <span className="process-group-title sr-only">{t('process.group_title')}</span>
            <span className="process-group-total-badge">{totalBadge}</span>
          </span>
        </div>

        {/* General Toggle Button with + / - sign */}
        <div className="process-group-header-right">
          <button
            type="button"
            className="process-btn-general-toggle"
            onClick={handleToggleGeneral}
            aria-expanded={allExpanded}
            title={allExpanded ? t('process.collapse_all') : t('process.expand_all')}
          >
            <span className="process-toggle-sign" aria-hidden="true">
              {allExpanded ? '−' : '+'}
            </span>
            <span className="process-toggle-label">
              {allExpanded ? t('process.collapse_all') : t('process.expand_all')}
            </span>
          </button>
        </div>
      </div>

      {/* Categories List */}
      <div className="process-group-categories">
        {categories.map((cat) => {
          const items = group.byCategory[cat] || [];
          const count = items.length;
          const isExpanded = expandedCategories.has(cat);
          const details = getCategoryDetails(cat, count, t);

          const hasCatErrors = items.some(
            (i) => i.block.type === 'tool_call' && (i.block.status === 'error' || i.block.isError)
          );
          const hasCatRunning = items.some(
            (i) =>
              (i.block.type === 'tool_call' && i.block.status === 'running') ||
              (i.block.type === 'thinking' && i.block.isStreaming)
          );

          const catErrorCount = items.filter(
            (i) => i.block.type === 'tool_call' && (i.block.status === 'error' || i.block.isError)
          ).length;

          const catStatusLabel = hasCatRunning
            ? t('activity.tool_status_running')
            : hasCatErrors
              ? (catErrorCount === 1 ? t('process.cat_warning_one') : t('process.cat_warning_count', { count: catErrorCount }))
              : t('activity.tool_status_completed');

          const catStatusClass = hasCatRunning
            ? 'status-running'
            : hasCatErrors
              ? 'status-error'
              : 'status-completed';

          const subagents = cat === 'agents' ? extractDiscoveredSubagents(items) : [];

          return (
            <div
              key={cat}
              className={`process-category-row ${isExpanded ? 'is-expanded' : 'is-collapsed'} ${catStatusClass}`}
            >
              {/* Category Bar with + / - sign */}
              <button
                type="button"
                className="process-category-toggle-btn"
                onClick={() => handleToggleCategory(cat)}
                aria-expanded={isExpanded}
                title={`${isExpanded ? t('process.collapse') : t('process.expand')} ${details.label}`}
              >
                <div className="category-toggle-left">
                  <span className="process-toggle-sign" aria-hidden="true">
                    {isExpanded ? '−' : '+'}
                  </span>
                  <span className="category-glyph" aria-hidden="true">
                    {details.glyph}
                  </span>
                  <span className="category-name">{details.label}</span>
                  <span className="category-count">{details.countLabel}</span>
                  {cat === 'agents' && subagents.length > 0 && (
                    <span className="category-subagent-pills">
                      {subagents.map((agent) => {
                        const isWorking = agent.status === 'running';
                        const isError = agent.status === 'error';
                        const pillClass = isWorking
                          ? 'status-working'
                          : isError
                            ? 'status-error'
                            : 'status-idle';
                        const dotClass = isWorking
                          ? 'dot-working'
                          : isError
                            ? 'dot-error'
                            : 'dot-idle';
                        const tooltipStatus = isWorking
                          ? t('activity.tool_status_running')
                          : isError
                            ? t('activity.tool_status_failed')
                            : t('activity.tool_status_completed');

                        return (
                          <span
                            key={agent.name}
                            className={`subagent-pill ${pillClass}`}
                            title={`${agent.name} (${tooltipStatus})`}
                          >
                            <span className={`subagent-pill-dot ${dotClass}`} aria-hidden="true" />
                            <span className="subagent-pill-name">{agent.name}</span>
                          </span>
                        );
                      })}
                    </span>
                  )}
                </div>

                <div className="category-toggle-right">
                  <span className={`category-status-indicator ${catStatusClass}`}>
                    <span className={`status-pill-dot dot-${hasCatRunning ? 'running' : hasCatErrors ? 'error' : 'completed'}`} aria-hidden="true" />
                    <span>{catStatusLabel}</span>
                  </span>
                </div>
              </button>

              {/* Expanded Category Items */}
              {isExpanded && (
                <div className="process-category-items-container" role="region" aria-label={details.label}>
                  {items.map((item, itemIdx) => {
                    if (item.block.type === 'thinking') {
                      return (
                        <ThinkingCard
                          key={item.id || `think-${itemIdx}`}
                          block={item.block}
                          t={t}
                        />
                      );
                    }
                    if (item.block.type === 'tool_call') {
                      return (
                        <ToolCard
                          key={item.id || `tool-${itemIdx}`}
                          block={item.block}
                          t={t}
                        />
                      );
                    }
                    return null;
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
