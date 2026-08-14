## Usage Example: `assert`

### Basic Usage

```typescript
import { assert } from '@/utils';

function processValue(value: number | null) {
  assert(value !== null, 'Value must not be null');
  // TypeScript now knows value is number
  return value * 2;
}
```

### With Context

```typescript
assert(user.isLoggedIn, 'User must be logged in', { userId: user.id });
```

### Using with tryCatch

```typescript
import { assert, tryCatch } from '@/utils';

async function processAudio(fileId: string) {
  // Use tryCatch to handle potential errors
  const result = await tryCatch(
    () => fetchAudioFile(fileId),
    'Audio file fetch failed'
  );

  // Assert to ensure success and narrow types
  assert(!result.error, 'Audio processing failed', { fileId });

  // Now TypeScript knows result.data exists and is not null
  return applyEffects(result.data);
}
```

**Tip:**

- Use `assert` to enforce invariants and help TypeScript with type narrowing.
- Optionally provide a `context` object for easier debugging.
