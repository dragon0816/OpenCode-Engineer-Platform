import { createHash, randomUUID } from 'node:crypto';
import { key } from '../../../../packages/knowledge/src/ingest.ts';
import type { Candidate, ChangeSet } from '../../../../packages/knowledge/src/ingest.ts';
import type { BiOccurrence } from '../../../../packages/knowledge/src/jobs/scheduler.ts';
import type { KnowledgeStore } from '../../../../packages/knowledge/src/store.ts';
import type { Runtime } from '../../../launcher/src/runtime.ts';
import { proposeReview } from '../http/review.ts';
import type { Dispatcher } from '../runs/dispatcher.ts';
import type { WorkItem } from '../runs/work-items.ts';
import type { BiService } from './service.ts';

type ReviewRequest = { id: string; vault: string; draft?: ChangeSet; proposal?: Record<string, unknown> };
type ReviewResult = Awaited<ReturnType<typeof proposeReview>>;

export function dispatchBi(dispatcher: Dispatcher, bi: BiService, store?: KnowledgeStore,
  propose?: NonNullable<Runtime['knowledge']>['propose']) {
  const canRun = (item: WorkItem) => store?.canRunBi(String(item.payload.job)) ?? false;
  dispatcher.register('bi-job', {
    available: canRun,
    async execute(item, start) {
      const job = String(item.payload.job);
      const candidate = item.payload.candidate as Candidate | undefined;
      start();
      // enqueueBi and completion each commit an atomic local transaction. The job ID is their common key.
      try {
        if (candidate) store!.enqueueBi(job, candidate, item.scheduleRef ? 'schedule' : 'owner', item.id);
        store!.runBi(job);
        return { state: 'succeeded' };
      } catch {
        return { state: 'failed', reason: 'bi-job-failed' };
      }
    },
    async recover(item) {
      if (!store) return;
      // An incomplete job has no committed review/effect. Running this local transaction needs no external replay.
      return store.biCompleted(String(item.payload.job)) ? { state: 'succeeded' } : 'never-started';
    },
    async canResolve(item, outcome) {
      return outcome !== 'succeeded' || Boolean(store?.biCompleted(String(item.payload.job)));
    },
  });

  dispatcher.register('bi-source', {
    async execute(item, start, stop) {
      const source = Number(item.payload.sourceId);
      if (item.payload.supplement !== undefined && !bi.canSupplement(source)) return { state: 'failed', reason: 'source-unavailable' };
      start();
      if (typeof item.payload.supplement === 'string') await bi.supplement(source, item.payload.supplement, stop, undefined, item.id);
      else await bi.stage(source, stop, item.id);
      stop.throwIfAborted();
      return { state: 'succeeded' };
    },
    async recover(item) {
      return bi.recover(Number(item.payload.sourceId), item.id) ? { state: 'succeeded' } : undefined;
    },
    async canResolve(item, outcome) {
      return outcome !== 'succeeded' || Boolean(bi.recover(Number(item.payload.sourceId), item.id));
    },
    resolved(item, outcome) {
      if (outcome !== 'succeeded') bi.stopUnverified(Number(item.payload.sourceId), item.id);
    },
  });

  const reviewResult = new Map<string, ReviewResult | undefined>();
  const reviewProvenance = (item: WorkItem) => ({ origin: 'owner' as const, sourceKey: 'work:' + item.id });
  const reviewEffect = (item: WorkItem) => {
    const request = item.payload.review as ReviewRequest;
    return store?.hasReview(request.id, request.vault, reviewProvenance(item));
  };
  dispatcher.register('bi-review', {
    available: () => Boolean(store),
    async execute(item, start, stop) {
      const request = item.payload.review as ReviewRequest;
      let result: ReviewResult = { id: request.id };
      if (request.proposal) {
        try {
          result = await proposeReview(store!, request.proposal, (prompt, input, signal) => {
            start();
            return propose!(prompt, input, signal);
          }, stop, reviewProvenance(item));
        } catch (error) {
          if (stop.aborted) throw error;
          return { state: 'failed', reason: 'bi-proposal-failed' };
        }
      } else {
        start();
        try { store!.stage(request.id, request.draft!, reviewProvenance(item)); }
        catch { return { state: 'failed', reason: 'bi-stage-failed' }; }
      }
      if (reviewResult.has(item.id)) reviewResult.set(item.id, result);
      return { state: 'succeeded' };
    },
    async recover(item) {
      if (reviewEffect(item)) return { state: 'succeeded' };
      if (store && !(item.payload.review as ReviewRequest).proposal) return 'never-started';
    },
    async canResolve(item, outcome) { return outcome !== 'succeeded' || Boolean(reviewEffect(item)); },
  });

  const jobKey = (job: string) => 'bi-job:' + job;
  const nextAttempt = (base: string, retry: (item: WorkItem) => boolean) => {
    let sourceKey = base;
    let prior = dispatcher.items.find('direct', sourceKey);
    while (prior && retry(prior)) {
      sourceKey = base + ':' + prior.id;
      prior = dispatcher.items.find('direct', sourceKey);
    }
    return { sourceKey, prior };
  };
  const canRetry = ({ state }: WorkItem) => state === 'failed' || state === 'cancelled' || state === 'timed_out';
  const submit = (job: string, candidate?: Candidate) => {
    if (!store) throw new Error('Knowledge is unavailable');
    key(job);
    const { sourceKey, prior } = nextAttempt(jobKey(job), canRetry);
    const scheduled = !prior && !candidate && dispatcher.items.find('schedule', jobKey(job));
    const existing = !candidate && (prior || scheduled && !canRetry(scheduled) && scheduled);
    return existing || dispatcher.enqueue({ agentId: 'bi', source: 'direct', sourceKey, effectClass: 'write',
      payload: { kind: 'bi-job', job, candidate } });
  };
  const wait = async (item: WorkItem, signal?: AbortSignal) => {
    const done = await dispatcher.wait(item.id, signal);
    if (done.state !== 'succeeded') throw new Error('BI work is unavailable');
  };

  return {
    occurrence({ job, schedule, candidate }: BiOccurrence) {
      const item = dispatcher.enqueue({ agentId: 'bi', source: 'schedule', sourceKey: jobKey(job), effectClass: 'write', scheduleRef: schedule,
        payload: { kind: 'bi-job', job, candidate } });
      if (store?.biCompleted(job)) return 'awaiting_review';
      if (item.state === 'failed' || item.state === 'cancelled') return 'blocked';
      return 'queued';
    },
    async runOccurrence(job: string, signal: AbortSignal) {
      const item = dispatcher.items.find('schedule', jobKey(job));
      if (item && item.state !== 'failed') await dispatcher.wait(item.id, signal);
    },
    run(job: string, candidate?: Candidate, signal?: AbortSignal) {
      return wait(submit(job, candidate), signal);
    },
    supplement(id: number, input: unknown, signal: AbortSignal) {
      const supplement = bi.validateSupplement(id, input);
      const hash = createHash('sha256').update(supplement).digest('hex');
      const { sourceKey } = nextAttempt(`bi-supplement:${id}:${hash}`,
        (prior) => canRetry(prior) || prior.state === 'succeeded' && bi.canSupplement(id));
      const item = dispatcher.enqueue({ agentId: 'bi', source: 'direct', sourceKey,
        effectClass: 'write', payload: { kind: 'bi-source', sourceId: id, supplement } });
      return wait(item, signal);
    },
    async review(input: Record<string, unknown>, signal?: AbortSignal) {
      if (!store) throw new Error('Knowledge is unavailable');
      const id = key(input.id);
      const draft = input.action === 'stage-change' ? input.draft as ChangeSet : undefined;
      const vault = key(draft?.vault?.id ?? input.vault);
      const sourceKey = draft ? nextAttempt('bi-review:' + id + ':' + createHash('sha256').update(JSON.stringify(draft)).digest('hex'),
        canRetry).sourceKey :
        'bi-proposal:' + randomUUID();
      const item = dispatcher.enqueue({ agentId: 'bi', source: 'direct', sourceKey, effectClass: 'write',
        payload: { kind: 'bi-review', review: { id, vault, draft, proposal: draft ? undefined : input } } });
      reviewResult.set(item.id, undefined);
      try {
        await wait(item, signal);
        return reviewResult.get(item.id) ?? { id };
      } finally { reviewResult.delete(item.id); }
    },
    recoverSource(id: number, recordedWork: unknown) {
      if (typeof recordedWork === 'string') {
        const prior = dispatcher.items.get(recordedWork);
        if (prior?.reasonCode === 'owner-resolved' && (prior.state === 'cancelled' || prior.state === 'failed')) {
          bi.stopUnverified(id, prior.id);
        }
        return;
      }
      dispatcher.enqueue({ agentId: 'bi', source: 'direct', sourceKey: 'bi-stage:' + id, effectClass: 'write',
        payload: { kind: 'bi-source', sourceId: id } });
    },
    recoverJobs() {
      for (const { id, workId } of store?.pendingBi() ?? []) {
        const job = String(id);
        if (typeof workId === 'string' && dispatcher.items.get(workId) || dispatcher.items.find('direct', jobKey(job))) continue;
        if (dispatcher.items.find('schedule', jobKey(job))) continue;
        dispatcher.enqueue({ agentId: 'bi', source: 'schedule', sourceKey: jobKey(job), effectClass: 'write',
          payload: { kind: 'bi-job', job } });
      }
    },
  };
}
