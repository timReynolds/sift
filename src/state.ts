import { defineDoc } from '@earendil-works/pi-durable';
import { emptyReviewState, type ReviewState } from './contracts.ts';

/** Pi transactions own application state as well as model/task state. */
export const ReviewDoc = defineDoc<ReviewState>({
  kind: 'sift.review',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: emptyReviewState,
});
