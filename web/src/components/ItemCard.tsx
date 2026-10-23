import { Link } from 'react-router';
import type { ItemSummary } from '../api.ts';
import { timeAgo } from '../format.ts';

export function KindBadges({ item }: { item: Pick<ItemSummary, 'kind' | 'format' | 'visibility'> }) {
  return (
    <span className="badges">
      <span className={`badge badge-kind badge-${item.kind}`}>{item.kind}</span>
      {item.format && <span className="badge">{item.format}</span>}
      <span className={`badge badge-${item.visibility}`}>{item.visibility}</span>
    </span>
  );
}

/** Row selection for bulk actions; `disabled` when the user cannot edit the item. onToggle gets whether Shift was held. */
export interface CardSelect {
  checked: boolean;
  disabled: boolean;
  onToggle: (shift: boolean) => void;
}

export function ItemCard({ item, select }: { item: ItemSummary; select?: CardSelect }) {
  const label = item.title || item.name;
  return (
    <li className={`card item-card${select?.checked ? ' is-selected' : ''}`}>
      <div className="item-card-head">
        <span className="item-card-name">
          {select && (
            <label className="item-card-select" title={select.disabled ? 'You cannot edit this item' : undefined}>
              <input
                type="checkbox"
                checked={select.checked}
                disabled={select.disabled}
                aria-label={select.disabled ? `${label} (you cannot edit this item)` : `Select ${label}`}
                onChange={(e) => select.onToggle((e.nativeEvent as MouseEvent).shiftKey === true)}
              />
            </label>
          )}
          <Link to={`/items/${item.id}`} className="item-card-title">
            {label}
          </Link>
        </span>
        <KindBadges item={item} />
      </div>
      <code className="muted">{item.name}</code>
      {item.description && <p className="clamp-2">{item.description}</p>}
      {item.tags.length > 0 && (
        <ul className="tags" aria-label="Tags">
          {item.tags.map((t) => (
            <li key={t} className="tag">
              {t}
            </li>
          ))}
        </ul>
      )}
      <p className="item-card-meta muted">
        {item.owner.username} · v{item.latestSeq} · <time dateTime={item.updatedAt}>{timeAgo(item.updatedAt)}</time>
      </p>
    </li>
  );
}
