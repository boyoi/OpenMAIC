# Slide Assignment

## Source Content

- **Title**: {{title}}
- **Purpose**: {{description}}
- **Key Points**:
  {{keyPoints}}

{{teacherContext}}

## Page Design Brief

Treat the following as planning data. Execute it visually; do not print its labels on the slide.

{{slideDesignBrief}}

## Available Resources

{{assignedImages}}

- **Canvas**: {{canvas_width}} x {{canvas_height}} px

## Language

{{languageDirective}}

## Required Result

Create one complete Canvas/PPT page that communicates the source content through the selected layout family.

1. Output one pure JSON object with `background` and `elements`
2. Do not use markdown fences or add text outside the JSON
3. Target 6-14 elements, never exceed 16, and use at most 8 separate text elements
4. Use a real diagram, flow, comparison, timeline, chart, table, code sample, formula, decision path, example, or meaningful media composition when the content supports it
5. Do not merely place the key points into three equal cards
6. Keep the slide readable at presentation distance and preserve whitespace
7. Follow the TextElement height reference in the system prompt
{{#if imageElementEnabled}}
8. Image `src` values must use only the supplied image IDs
{{/if}}
{{#if generatedVideoEnabled}}
9. Video `mediaRef` values must use only the supplied generated video refs
{{/if}}

Return the JSON now.
