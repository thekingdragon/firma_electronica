import type { RequestStatus, ReviewResult } from '../api';
import { REVIEW_LABEL, STATUS_LABEL } from '../format';

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

/** Estado de la revisión humana de una firma. «Sin revisar» es la que pide atención. */
export function ReviewBadge({ review }: { review: ReviewResult | null }) {
  if (!review) return <span className="badge badge-unreviewed">Sin revisar</span>;
  return <span className={`badge ${review === 'VERIFIED' ? 'badge-signed' : 'badge-rejected'}`}>{REVIEW_LABEL[review]}</span>;
}
