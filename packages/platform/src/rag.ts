export const SIMPLE_EMBEDDING_DIMENSIONS = 64;

export function chunkText(text: string, maxChars: number): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError("maxChars must be a positive integer");
  }

  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const boundary = window.search(/\s+\S*$/);
    const cutAt = boundary > 0 ? boundary : maxChars;
    const chunk = remaining.slice(0, cutAt).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new RangeError("Vectors must have equal dimensions");
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function simpleEmbed(text: string): number[] {
  const vector = Array<number>(SIMPLE_EMBEDDING_DIMENSIONS).fill(0);
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    const dimension = hashToken(token) % SIMPLE_EMBEDDING_DIMENSIONS;
    vector[dimension] = (vector[dimension] ?? 0) + 1;
  }
  return vector;
}
