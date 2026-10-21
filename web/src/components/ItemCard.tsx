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

export function ItemCard({ item }: { item: ItemSummary }) {
  return (
    <li className="card item-card">
      <div className="item-card-head">
        <Link to={`/items/${item.id}`} className="item-card-title">
          {item.title || item.name}
        </Link>
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
