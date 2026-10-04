import type { RequestStatus } from '../api';
import { STATUS_LABEL } from '../format';

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <span className={`badge badge-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}
