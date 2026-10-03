import React, { useState } from 'react';
import type { TranslationKey } from '@shared/i18n';
import {
  categorizeBlock,
  PROCESS_CATEGORY_ORDER,
  type ProcessCategory,
  type ProcessGroup,
} from '@core/process-grouping';
import { ThinkingCard, ToolCard } from './ActivityBlocks';

export interface ProcessGroupCardProps {
  group: ProcessGroup;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const CATEGORY_LABEL_KEYS: Record<ProcessCategory, TranslationKey> = {
  bash: 'process_group.category_bash',
  edit: 'process_group.category_edit',
  read: 'process_group.category_read',
  write: 'process_group.category_write',
  search: 'process_group.category_search',
  agents: 'process_group.category_agents',
  thinking: 'process_group.category_thinking',
  other: 'process_group.category_other',
};

/**
 * Compact card for a `ProcessGroup` (Issue #8): a run of consecutive thinking/tool_call
 * blocks within one assistant turn. Shows the total activity count and a badge per
 * category present, a global expand/compact toggle, and per-category +/- controls that
 * reveal that category's child cards (reusing the existing `ThinkingCard`/`ToolCard`).
 */
const ProcessGroupCardComponent: React.FC<ProcessGroupCardProps> = ({ group, t }) => {
  const [expandedCategories, setExpandedCategories] = useState<ReadonlySet<ProcessCategory>>(
    () => new Set()
  );

  const orderedCategories = PROCESS_CATEGORY_ORDER.filter((cat) =>
    group.categoryOrder.includes(cat)
  );
  const allExpanded =
    orderedCategories.length > 0 && orderedCategories.every((cat) => expandedCategories.has(cat));

  const toggleCategory = (category: ProcessCategory) => {
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

  const handleGlobalToggle = () => {
    setExpandedCategories(allExpanded ? new Set() : new Set(orderedCategories));
  };

  return (
    <div
      className={`process-group-card${group.hasError ? ' process-group-has-error' : ''}`}
    >
      <div className="process-group-header">
        <div className="process-group-summary">
          <span className="process-group-count">
            {t('process_group.activity_count', { count: group.total })}
          </span>
          <div className="process-group-badges">
            {orderedCategories.map((cat) => (
              <span key={cat} className={`process-badge process-badge-${cat}`}>
                {t(CATEGORY_LABEL_KEYS[cat])} · {group.counts[cat] ?? 0}
              </span>
            ))}
            {group.hasError && (
              <span className="process-badge process-badge-observations">
                {t('process_group.with_observations')}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="process-group-global-toggle"
          onClick={handleGlobalToggle}
          aria-expanded={allExpanded}
        >
          {allExpanded ? t('process_group.compact_all') : t('process_group.expand_all')}
        </button>
      </div>

      <div className="process-group-categories">
        {orderedCategories.map((cat) => {
          const isExpanded = expandedCategories.has(cat);
          const blocksInCategory = group.blocks.filter((block) => categorizeBlock(block) === cat);

          return (
            <div className="process-category-row" key={cat}>
              <button
                type="button"
                className="process-category-toggle"
                onClick={() => toggleCategory(cat)}
                aria-expanded={isExpanded}
              >
                <span className="process-category-sign" aria-hidden="true">
                  {isExpanded ? '−' : '+'}
                </span>
                <span className="process-category-label">{t(CATEGORY_LABEL_KEYS[cat])}</span>
                <span className="process-category-count">{group.counts[cat] ?? 0}</span>
              </button>

              {isExpanded && (
                <div className="process-category-children">
                  {blocksInCategory.map((block, idx) =>
                    block.type === 'thinking' ? (
                      <ThinkingCard key={`thinking-${cat}-${idx}`} block={block} t={t} />
                    ) : (
                      <ToolCard key={block.id || `tool-${cat}-${idx}`} block={block} t={t} />
                    )
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const ProcessGroupCard: React.FC<ProcessGroupCardProps> = Object.assign(
  (props: ProcessGroupCardProps) => ProcessGroupCardComponent(props),
  React.memo(ProcessGroupCardComponent)
) as unknown as React.FC<ProcessGroupCardProps>;
