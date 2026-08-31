const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  resolveVariationImage,
  classifyJobResponse,
  friendlyErrorMessage,
} = require('../../assets/widget-logic.js');

test('resolveVariationImage: uses the variation image when the payload has one', () => {
  const result = resolveVariationImage('https://example.com/parent.jpg', {
    image: { src: 'https://example.com/variant.jpg' },
  });
  assert.equal(result, 'https://example.com/variant.jpg');
});

test('resolveVariationImage: falls back to the parent image when the variation image is empty', () => {
  const result = resolveVariationImage('https://example.com/parent.jpg', { image: { src: '' } });
  assert.equal(result, 'https://example.com/parent.jpg');
});

test('resolveVariationImage: falls back to the parent image when there is no variation payload yet', () => {
  const result = resolveVariationImage('https://example.com/parent.jpg', null);
  assert.equal(result, 'https://example.com/parent.jpg');
});

test('classifyJobResponse: 401 maps to unavailable with no retry', () => {
  const result = classifyJobResponse(401, {});
  assert.deepEqual(result, { state: 'unavailable' });
});

test('classifyJobResponse: 403 maps to unavailable', () => {
  const result = classifyJobResponse(403, {});
  assert.deepEqual(result, { state: 'unavailable' });
});

test('classifyJobResponse: 202 with status QUEUED maps to queued', () => {
  const result = classifyJobResponse(202, { jobId: 'j1', status: 'QUEUED' });
  assert.deepEqual(result, { state: 'queued' });
});

test('classifyJobResponse: 200 with status RUNNING maps to running', () => {
  const result = classifyJobResponse(200, { jobId: 'j1', status: 'RUNNING' });
  assert.deepEqual(result, { state: 'running' });
});

test('classifyJobResponse: 200 with status COMPLETED maps to completed with the image url', () => {
  const result = classifyJobResponse(200, {
    jobId: 'j1',
    status: 'COMPLETED',
    imageUrl: 'https://x/y.jpg',
  });
  assert.deepEqual(result, { state: 'completed', imageUrl: 'https://x/y.jpg' });
});

test('classifyJobResponse: 200 with status FAILED maps to failed with the error code', () => {
  const result = classifyJobResponse(200, { jobId: 'j1', status: 'FAILED', error: 'JOB_FAILED' });
  assert.deepEqual(result, { state: 'failed', error: 'JOB_FAILED' });
});

test('classifyJobResponse: any other status maps to unavailable', () => {
  const result = classifyJobResponse(500, {});
  assert.deepEqual(result, { state: 'unavailable' });
});

test('friendlyErrorMessage: RATE_LIMITED gets a wait-and-retry message', () => {
  const result = friendlyErrorMessage(429, 'RATE_LIMITED', 'too many requests');
  assert.match(result, /wait a moment/);
});

test('friendlyErrorMessage: ENQUEUE_FAIL reassures the shopper they were not charged', () => {
  const result = friendlyErrorMessage(503, 'ENQUEUE_FAIL', 'queue unavailable');
  assert.match(result, /haven't been charged/);
});

test('friendlyErrorMessage: an oversized-file VALIDATION message is rewritten with guidance', () => {
  const result = friendlyErrorMessage(400, 'VALIDATION', 'person exceeds the 20MB limit');
  assert.equal(
    result,
    'Person exceeds the 20MB limit. Please choose a smaller photo and try again.',
  );
});

test('friendlyErrorMessage: an unrelated VALIDATION message falls back to the generic copy', () => {
  const result = friendlyErrorMessage(
    400,
    'VALIDATION',
    'garment must be a JPEG, PNG, or WebP image',
  );
  assert.equal(
    result,
    "We couldn't generate your try-on. Please try again with a different photo.",
  );
});

test('friendlyErrorMessage: an unrecognized failure falls back to the generic copy', () => {
  const result = friendlyErrorMessage(500, 'INTERNAL', 'internal error');
  assert.equal(
    result,
    "We couldn't generate your try-on. Please try again with a different photo.",
  );
});
