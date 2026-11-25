/**
 * Async Job Queue — handler registry
 *
 * Maps each job name to its processor function. The WorkerManager uses this map to
 * route jobs to handlers. Adding a new job is: define the data/result types in
 * types.ts, write a handler, and add it here + to QUEUE_DEFINITIONS.
 */

import { JobName, type JobDataMap, type JobNameValue, type JobResultMap } from '../types';
import type { HandlerJob } from './util';
import { handleBatchJob, getBatchProcessor, registerBatchProcessor } from './batch.handler';
import { handleCleanupJob } from './cleanup.handler';
import { handleEmailBlastJob, handleEmailJob } from './email.handler';
import { handleExportJob } from './export.handler';
import { handleSnapshotJob } from './snapshot.handler';

type Processor<N extends JobNameValue> = (
  job: HandlerJob<JobDataMap[N], JobResultMap[N]>,
) => Promise<JobResultMap[N]>;

// The loose-typed map used by the WorkerManager, which deals with BullMQ's generic
// `Job` and casts on the way in/out.
export const HANDLERS: { [N in JobNameValue]: Processor<N> } = {
  [JobName.Export]: handleExportJob as Processor<typeof JobName.Export>,
  [JobName.Email]: handleEmailJob as Processor<typeof JobName.Email>,
  [JobName.EmailBlast]: handleEmailBlastJob as Processor<typeof JobName.EmailBlast>,
  [JobName.Batch]: handleBatchJob as Processor<typeof JobName.Batch>,
  [JobName.Snapshot]: handleSnapshotJob as Processor<typeof JobName.Snapshot>,
  [JobName.Cleanup]: handleCleanupJob as Processor<typeof JobName.Cleanup>,
};

export { registerBatchProcessor, getBatchProcessor };
