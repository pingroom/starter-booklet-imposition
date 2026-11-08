import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const SIGNATURE_SIZES = Object.freeze([4, 8, 12, 16]);
export const POLICY = Object.freeze({ algorithm: 'two-up-nested-signatures-v1', binding: 'right-mirrors-each-face-v1', view: 'each-face-from-printed-side-v1', padding: 'tail-to-next-multiple-of-four-v1', sequence: 'manifest-page-order-v1' });
export const POLICY_HASH = hash(POLICY);
const safeId = value => word(value) && value.length <= 24 && !['constructor', 'prototype', '__proto__'].includes(value);

export function validateInput(input) {
  if (!keys(input, ['documentId', 'title', 'pages']) || !word(input.documentId) || !line(input.title, 40)
    || !Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > 64) throw new Error('Provide a document ID, title up to 40 characters and one to 64 ordered pages.');
  const ids = new Set();
  for (const page of input.pages) {
    if (!keys(page, ['id', 'label']) || !safeId(page.id) || ids.has(page.id) || !line(page.label, 40)) throw new Error('Pages require unique safe IDs and labels up to 40 characters. Array order is reading order.');
    ids.add(page.id);
  }
  return structuredClone(input);
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact print operator UUID and label.');
  return structuredClone(config);
}
export function tasksFor(input) {
  validateInput(input);
  return [{ id: 'binding', label: 'Binding edge' }, { id: 'signature-size', label: 'Maximum pages per signature' }];
}
export function parseSetting(taskId, text) {
  if (!['binding', 'signature-size'].includes(taskId)) throw new Error('Unknown booklet setting.');
  if (text === 'Unknown') return { kind: 'unknown', selection: null };
  if (taskId === 'binding' && ['Left', 'Right'].includes(text)) return { kind: 'binding', selection: text };
  if (taskId === 'signature-size' && ['4', '8', '12', '16'].includes(text)) return { kind: 'signature_size', selection: Number(text) };
  throw new Error(taskId === 'binding' ? 'Reply exactly Left, Right, or Unknown.' : 'Reply exactly 4, 8, 12, 16, or Unknown.');
}
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (!tasksFor(input).some(task => task.id === taskId) || !isId(attemptId)) throw new Error('Invalid setting or attempt.');
  const question = taskId === 'binding'
    ? 'Which edge binds the closed booklet? Reply Left, Right, or Unknown. This chooses page pairing, not a printer duplex setting.'
    : 'Maximum pages in each separately folded/nested signature? Reply 4, 8, 12, 16, or Unknown. The last signature uses only needed sheets and end blanks.';
  const prompt = `${input.title}\nDocument: ${input.documentId} (${input.pages.length} ordered pages)\nPage-manifest SHA-256: ${hash(input.pages)}\n${question}`;
  if (prompt.length > 500) throw new Error('Setting prompt exceeds 500 characters.');
  const key = `booklet-${attemptId}`;
  return { prompt, context: `To ${config.participant.id}`, text_input: { placeholder: taskId === 'binding' ? 'Left, Right, or Unknown' : '4, 8, 12, 16, or Unknown', max_length: 60 },
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), pages_hash: hash(input.pages), policy_hash: POLICY_HASH, task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

/** Each signature nests its own sheets; signatures are then gathered in order. */
export function impose(rawInput, binding, maxSignaturePages) {
  const input = validateInput(rawInput);
  if (!['Left', 'Right'].includes(binding) || !SIGNATURE_SIZES.includes(maxSignaturePages)) throw new Error('Use Left or Right binding and a signature size of 4, 8, 12 or 16.');
  const signatures = []; let sheetNumber = 0;
  for (let offset = 0; offset < input.pages.length; offset += maxSignaturePages) {
    const pages = input.pages.slice(offset, offset + maxSignaturePages), paddedPageCount = Math.ceil(pages.length / 4) * 4;
    const position = signaturePage => {
      const page = pages[signaturePage - 1];
      return page ? { kind: 'page', pageId: page.id, label: page.label, sourceIndex: offset + signaturePage, signaturePage }
        : { kind: 'blank', pageId: null, label: null, sourceIndex: null, signaturePage };
    };
    const face = (left, right) => binding === 'Left' ? { left: position(left), right: position(right) } : { left: position(right), right: position(left) };
    const sheets = [];
    for (let i = 0; i < paddedPageCount / 4; i++) sheets.push({ sheetIndex: i + 1, sheetNumber: ++sheetNumber,
      front: face(paddedPageCount - 2 * i, 1 + 2 * i), back: face(2 + 2 * i, paddedPageCount - 1 - 2 * i) });
    signatures.push({ signatureIndex: signatures.length + 1, sourceStartIndex: offset + 1, sourceEndIndex: offset + pages.length,
      sourcePageCount: pages.length, paddedPageCount, blankCount: paddedPageCount - pages.length, sheets });
  }
  const paddedPageCount = signatures.reduce((sum, signature) => sum + signature.paddedPageCount, 0);
  return { documentId: input.documentId, binding, maxSignaturePages, faceView: POLICY.view, assembly: 'nest-sheets-within-each-signature-then-gather-signatures-in-order',
    sourcePageCount: input.pages.length, paddedPageCount, blankCount: paddedPageCount - input.pages.length, signatureCount: signatures.length, sheetCount: sheetNumber, signatures };
}
export function bookletImposition(rawInput, answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length || Array.from(answers).some((row, index) => !keys(row, ['settingId', 'text']) || row.settingId !== tasks[index].id || row.text !== null && typeof row.text !== 'string')) throw new Error('Provide one ordered answer or missing outcome for each booklet setting.');
  const outcomes = answers.map(row => row.text === null ? { kind: 'missing', selection: null } : parseSetting(row.settingId, row.text));
  if (outcomes.some(row => ['unknown', 'missing'].includes(row.kind))) return { status: 'incomplete', plan: null };
  return { status: 'complete', plan: impose(input, outcomes[0].selection, outcomes[1].selection) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed ordered page manifest. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved selection request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = tasksFor(input).map(task => {
    const attempt = state.attempts.find(row => row.taskId === task.id), answer = attempt?.observation?.answer;
    return { settingId: task.id, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      text: answer?.text ?? null, kind: answer?.kind ?? null, selection: answer?.selection ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = bookletImposition(input, answers.map(({ settingId, text }) => ({ settingId, text })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  const evidence = { documentId: input.documentId, source: input, sourceHash: hash(input), configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, answers, plan: calculation.plan, documentBytesRead: false, documentRendered: false, printingExecuted: false };
  return { ...evidence, status, proposal: calculation.status === 'complete' ? { ...evidence, status: 'complete' } : null };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'selection', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseSetting(request.data.task_id, answer.text)) !== hash({ kind: answer.kind, selection: answer.selection })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or print operator.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseSetting(request.data.task_id, answer.text), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
