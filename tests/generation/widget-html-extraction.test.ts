import { describe, expect, it } from 'vitest';

import { generateWidgetContent } from '@/lib/generation/scene-generator';
import type { SceneOutline } from '@/lib/types/generation';

const OUTLINE: SceneOutline = {
  id: 'diagram-html-validation',
  type: 'interactive',
  title: 'Method lineage',
  description: 'Explore the relationships between methods.',
  keyPoints: ['Method A leads to Method B'],
  order: 0,
  widgetType: 'diagram',
  widgetOutline: {
    concept: 'Method lineage',
    diagramType: 'flowchart',
  },
};

describe('interactive widget HTML extraction', () => {
  it('accepts a complete HTML document with the expected structure', async () => {
    const content = await generateWidgetContent(
      OUTLINE,
      async () => `preface
<!DOCTYPE html>
<html lang="en">
  <head><title>Method lineage</title><style>body { margin: 0; }</style></head>
  <body><button id="next">Next</button><script>document.querySelector('#next');</script></body>
</html>
trailing prose`,
    );

    expect(content?.html).toContain('id="next"');
  });

  it.each([
    [
      'an unclosed document in a code fence',
      '```html\n<!DOCTYPE html><html><body><button>Next</button>\n```',
    ],
    ['an unclosed raw document', '<!DOCTYPE html><html><body><button>Next</button>'],
    ['a document without a body', '<!DOCTYPE html><html><head></head></html>'],
    [
      'a document with truncated interaction JavaScript',
      '<!DOCTYPE html><html><body><button>Next</button><script>function next() {</body></html>',
    ],
  ])('rejects %s', async (_label, response) => {
    await expect(generateWidgetContent(OUTLINE, async () => response)).resolves.toBeNull();
  });
});
