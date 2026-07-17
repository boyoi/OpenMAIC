import type { SceneOutline, SlideIntent } from '@/lib/types/generation';

export type SlideLayoutFamily =
  | 'editorial-cover'
  | 'focal-diagram'
  | 'horizontal-process'
  | 'split-comparison'
  | 'milestone-timeline'
  | 'layered-system'
  | 'chart-insight'
  | 'code-walkthrough'
  | 'worked-example'
  | 'case-transformation'
  | 'decision-path'
  | 'synthesis-map';

export interface SlidePalette {
  name: string;
  background: string;
  surface: string;
  ink: string;
  muted: string;
  primary: string;
  secondary: string;
  accent: string;
}

export interface ResolvedSlideDesign {
  intent: SlideIntent;
  layout: SlideLayoutFamily;
  variant: string;
  palette: SlidePalette;
  pageIndex: number;
  totalPages: number;
  previousIntent?: SlideIntent;
  nextIntent?: SlideIntent;
  visualBrief: string;
  layoutGuide: string;
}

const PALETTES: SlidePalette[] = [
  {
    name: 'teal-blue-coral',
    background: '#F5F7F8',
    surface: '#FFFFFF',
    ink: '#17212B',
    muted: '#5E6B78',
    primary: '#0F766E',
    secondary: '#2563EB',
    accent: '#E4573D',
  },
  {
    name: 'forest-indigo-amber',
    background: '#F7F8F4',
    surface: '#FFFFFF',
    ink: '#1D2620',
    muted: '#606B63',
    primary: '#287A4D',
    secondary: '#4F46A5',
    accent: '#D98A16',
  },
  {
    name: 'charcoal-cyan-red',
    background: '#F6F7F9',
    surface: '#FFFFFF',
    ink: '#20242A',
    muted: '#626A75',
    primary: '#087E8B',
    secondary: '#3A6EA5',
    accent: '#C8443E',
  },
  {
    name: 'navy-green-gold',
    background: '#F7F7F5',
    surface: '#FFFFFF',
    ink: '#182433',
    muted: '#5F6974',
    primary: '#22577A',
    secondary: '#2F855A',
    accent: '#C58B18',
  },
];

const INTENT_PATTERNS: Array<[SlideIntent, RegExp]> = [
  ['summary', /summary|recap|takeaways?|conclusion|wrap[- ]?up|总结|回顾|要点|结论|收束|复盘/i],
  [
    'comparison',
    /compare|comparison|versus|\bvs\.?\b|difference|trade[- ]?off|pros? and cons?|对比|比较|区别|差异|优劣|取舍/i,
  ],
  [
    'timeline',
    /timeline|history|evolution|roadmap|milestone|chronolog|时间线|历程|演进|路线图|里程碑|发展史/i,
  ],
  [
    'worked-example',
    /worked example|step[- ]by[- ]step solution|solve this|calculation walkthrough|例题|逐步求解|完整示范|操作示范|演算过程/i,
  ],
  [
    'code',
    /\bcode\b|coding|python|javascript|typescript|java\b|api\b|sdk\b|implementation|代码|编程|接口|调用|实现/i,
  ],
  [
    'data',
    /\[chart\]|metric|trend|growth|distribution|benchmark|survey|statistics?|数据|指标|趋势|增长|分布|统计|实验结果/i,
  ],
  [
    'architecture',
    /architecture|system|component|module|layer|pipeline|mechanism|topology|架构|系统|组件|模块|分层|机制|拓扑|数据流/i,
  ],
  [
    'process',
    /process|workflow|steps?|how to|lifecycle|procedure|journey|流程|步骤|方法|操作|生命周期|路径|闭环/i,
  ],
  [
    'case-study',
    /case study|before and after|situation.+result|transformation|案例分析|实战案例|改造前后|情境.+结果|前后对比/i,
  ],
  [
    'decision',
    /decision|checklist|criteria|rule|risk|diagnos|choose|selection|决策|清单|标准|规则|风险|诊断|选择|判断/i,
  ],
  [
    'cover',
    /introduction|overview|welcome|agenda|learning objectives?|简介|导入|概览|议程|学习目标|课程目标/i,
  ],
];

const LAYOUT_GUIDES: Record<SlideLayoutFamily, string> = {
  'editorial-cover':
    'Use an editorial opening: a dominant 44-52px title in the left 55-60% and one meaningful visual, diagram, or compact learning map on the right. Keep secondary copy to one short line. Do not use a row of equal cards.',
  'focal-diagram':
    'Use one dominant explanatory visual in a 540-620px region and a narrow 250-300px insight rail. Show relationships with position, containment, or 2-4 connectors. Include one concrete example or implication.',
  'horizontal-process':
    'Use a clear 3-5 step flow across the main content area. Give each step a short action label and a concrete output/checkpoint. Connectors must sit behind nodes and must not cross text.',
  'split-comparison':
    'Use a true two-sided comparison or a compact comparison table. Keep the two sides structurally parallel, highlight the decisive differences, and finish with one decision rule. Avoid generic pros/cons filler.',
  'milestone-timeline':
    'Use one horizontal timeline with 3-5 milestones, distinct dates/stages, and a concise consequence at each point. Alternate labels above and below only when spacing remains clear.',
  'layered-system':
    'Use a layered stack, hub-and-spoke, or left-to-right system map. Label components by function and show the main input-to-output path. Add one callout for the critical boundary or failure point.',
  'chart-insight':
    'Use a chart only when numeric values are present in the supplied content. Pair the chart with 1-2 evidence-backed findings and a practical implication. If no numeric data is supplied, use a labeled evidence map instead of inventing numbers.',
  'code-walkthrough':
    'Use one code element as the main visual, limited to the smallest useful 6-14 lines, plus a narrow annotation/output panel. Explain inputs, the critical line, and the observable result. Use executable code when possible; label pseudocode explicitly.',
  'worked-example':
    'Use a problem-input, visible steps, and verifiable result structure. Show only the reasoning or operations needed to reproduce the answer, and visually separate the final check.',
  'case-transformation':
    'Use before/after or situation-action-result structure. Make the initial condition, intervention, and observable outcome visually distinct. The slide must show what changed, not merely list three topics.',
  'decision-path':
    'Use a checklist, decision tree, or go/stop path with explicit criteria and outcomes. Emphasize the branch or threshold that changes the decision. Keep labels operational and testable.',
  'synthesis-map':
    'Use a synthesis map that connects 3-5 takeaways to one central conclusion or next action. Do not repeat earlier slides verbatim and do not use a generic card grid.',
};

const LAYOUT_VARIANTS: Record<SlideIntent, string[]> = {
  cover: ['editorial-left', 'editorial-right'],
  concept: [
    'visual-left-insight-right',
    'insight-left-visual-right',
    'central-model-with-callouts',
  ],
  process: ['horizontal-stage-gates', 'zigzag-handoffs', 'vertical-action-output'],
  comparison: ['balanced-split', 'decision-matrix', 'continuum-with-threshold'],
  timeline: ['alternating-milestones', 'phase-bands'],
  architecture: ['layered-stack', 'hub-and-spoke', 'input-system-output'],
  data: ['chart-left-findings-right', 'headline-metric-over-chart'],
  code: ['code-left-output-right', 'code-top-execution-bottom'],
  'worked-example': ['problem-steps-result', 'input-method-check'],
  'case-study': ['before-after', 'situation-action-result'],
  decision: ['branching-go-stop', 'criteria-checklist'],
  summary: ['central-synthesis', 'takeaway-path'],
};

const VARIANT_GUIDES: Record<string, string> = {
  'editorial-left':
    'Place the title/value proposition on the left and the visual learning map on the right.',
  'editorial-right':
    'Place the visual hook on the left and the title/value proposition on the right.',
  'visual-left-insight-right':
    'Reserve roughly 60% width for the explanatory visual and 30% for the insight rail.',
  'insight-left-visual-right':
    'Use a narrow conclusion/example rail on the left and the main explanatory visual on the right.',
  'central-model-with-callouts':
    'Center one model and place 2-4 short callouts around it with clean connectors.',
  'horizontal-stage-gates':
    'Lay out stages left to right with a visible output or gate between stages.',
  'zigzag-handoffs':
    'Alternate 3-5 stages across two rows and make handoffs explicit without crossing labels.',
  'vertical-action-output':
    'Use a compact vertical sequence where every action has a paired output/checkpoint.',
  'balanced-split':
    'Use mirrored left/right structures and reserve the bottom for the choice rule.',
  'decision-matrix': 'Use a compact table or 2x2 matrix with highlighted decisive cells.',
  'continuum-with-threshold':
    'Place options on a continuum and mark the threshold where the recommendation changes.',
  'alternating-milestones':
    'Use one baseline with labels alternating above and below at even spacing.',
  'phase-bands': 'Use 3-5 horizontal phase bands with clear transition labels and outcomes.',
  'layered-stack':
    'Show system layers as aligned horizontal bands and mark the main path through them.',
  'hub-and-spoke':
    'Use one central component with 3-5 functional spokes and short relationship labels.',
  'input-system-output':
    'Use a left-to-right architecture with inputs, processing boundary, and observable outputs.',
  'chart-left-findings-right':
    'Use the chart as the dominant left visual and place 1-2 findings plus implication on the right.',
  'headline-metric-over-chart':
    'Lead with one supported metric, then place the chart beneath it with a concise interpretation.',
  'code-left-output-right':
    'Use code as the dominant left block and a result/annotation panel on the right.',
  'code-top-execution-bottom':
    'Place the code across the upper content area and show execution flow or output below.',
  'problem-steps-result':
    'Place the problem/input first, show 2-4 numbered transformations, and make the verified result dominant.',
  'input-method-check':
    'Use three unequal regions for input, method, and final check, with the method as the main visual.',
  'before-after':
    'Use parallel before/after regions and visually isolate the change mechanism between them.',
  'situation-action-result':
    'Use a directional three-stage case narrative with the result visually dominant.',
  'branching-go-stop': 'Show criteria leading to explicit go/stop or option A/B branches.',
  'criteria-checklist':
    'Use a concise checklist with thresholds and a final decision/output region.',
  'central-synthesis': 'Connect 3-5 takeaways around one central conclusion and next action.',
  'takeaway-path': 'Arrange takeaways as a path that ends in a concrete next action.',
};

function hashText(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function selectPalette(deckIdentity: string): SlidePalette {
  if (
    /health|medical|biology|ecology|environment|nature|wellness|健康|医疗|医学|生物|生态|环境|自然/i.test(
      deckIdentity,
    )
  ) {
    return PALETTES[1];
  }
  if (
    /finance|business|strategy|market|management|econom|金融|商业|战略|市场|管理|经济/i.test(
      deckIdentity,
    )
  ) {
    return PALETTES[3];
  }
  if (
    /design|culture|history|society|communication|art|设计|文化|历史|社会|沟通|艺术/i.test(
      deckIdentity,
    )
  ) {
    return PALETTES[2];
  }
  if (
    /ai\b|software|code|api\b|data|system|engineering|算法|软件|代码|接口|数据|系统|工程/i.test(
      deckIdentity,
    )
  ) {
    return PALETTES[0];
  }
  return PALETTES[hashText(deckIdentity) % PALETTES.length];
}

function outlineText(outline: SceneOutline): string {
  return [outline.title, outline.description, ...(outline.keyPoints || [])].join(' ');
}

function isSlideIntent(value: unknown): value is SlideIntent {
  return [
    'cover',
    'concept',
    'process',
    'comparison',
    'timeline',
    'architecture',
    'data',
    'code',
    'worked-example',
    'case-study',
    'decision',
    'summary',
  ].includes(String(value));
}

export function inferSlideIntent(outline: SceneOutline, totalPages = 1): SlideIntent {
  if (isSlideIntent(outline.slideIntent)) return outline.slideIntent;

  const text = outlineText(outline);
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(text)) return intent;
  }

  if (outline.order === 1 && totalPages > 1) return 'cover';
  if (outline.order === totalPages && totalPages > 2) return 'summary';
  return 'concept';
}

function layoutForIntent(intent: SlideIntent): SlideLayoutFamily {
  switch (intent) {
    case 'cover':
      return 'editorial-cover';
    case 'process':
      return 'horizontal-process';
    case 'comparison':
      return 'split-comparison';
    case 'timeline':
      return 'milestone-timeline';
    case 'architecture':
      return 'layered-system';
    case 'data':
      return 'chart-insight';
    case 'code':
      return 'code-walkthrough';
    case 'worked-example':
      return 'worked-example';
    case 'case-study':
      return 'case-transformation';
    case 'decision':
      return 'decision-path';
    case 'summary':
      return 'synthesis-map';
    default:
      return 'focal-diagram';
  }
}

function defaultVisualBrief(intent: SlideIntent): string {
  switch (intent) {
    case 'cover':
      return 'Establish the topic, audience value, and learning route in one glance.';
    case 'process':
      return 'Turn the key points into an ordered workflow with actions, handoffs, and outputs.';
    case 'comparison':
      return 'Show the dimensions that materially distinguish the options and the rule for choosing.';
    case 'timeline':
      return 'Show how stages or events change over time and why each transition matters.';
    case 'architecture':
      return 'Show components, boundaries, and the main input-to-output relationship.';
    case 'data':
      return 'Turn supplied numeric evidence into a chart and state the decision-relevant insight.';
    case 'code':
      return 'Show the smallest useful code path, annotate the critical line, and display the result.';
    case 'worked-example':
      return 'Show the input or problem, the reproducible steps, and a clearly verified answer or output.';
    case 'case-study':
      return 'Make the starting situation, intervention, and observable result easy to compare.';
    case 'decision':
      return 'Translate the content into operational checks, thresholds, branches, and outcomes.';
    case 'summary':
      return 'Synthesize the deck into a connected mental model and a concrete next action.';
    default:
      return 'Explain one central idea through a relationship diagram and one concrete example.';
  }
}

export function resolveSlideDesign(
  outline: SceneOutline,
  allOutlines: SceneOutline[] = [outline],
): ResolvedSlideDesign {
  const slideOutlines = allOutlines.filter((item) => item.type === 'slide');
  const deck = slideOutlines.length > 0 ? slideOutlines : [outline];
  const foundIndex = deck.findIndex((item) => item.id === outline.id);
  const currentIndex = foundIndex >= 0 ? foundIndex : 0;
  const totalPages = deck.length;
  const intent = inferSlideIntent(outline, totalPages);
  const previous = currentIndex > 0 ? deck[currentIndex - 1] : undefined;
  const next = currentIndex < totalPages - 1 ? deck[currentIndex + 1] : undefined;
  const deckIdentity = deck.map((item) => item.title).join('|') || outline.title;
  const palette = selectPalette(deckIdentity);
  const layout = layoutForIntent(intent);
  const variants = LAYOUT_VARIANTS[intent];
  const variant = variants[currentIndex % variants.length];

  return {
    intent,
    layout,
    variant,
    palette,
    pageIndex: currentIndex + 1,
    totalPages,
    previousIntent: previous ? inferSlideIntent(previous, totalPages) : undefined,
    nextIntent: next ? inferSlideIntent(next, totalPages) : undefined,
    visualBrief:
      typeof outline.visualBrief === 'string' && outline.visualBrief.trim()
        ? outline.visualBrief.trim()
        : defaultVisualBrief(intent),
    layoutGuide: `${LAYOUT_GUIDES[layout]} Variant: ${VARIANT_GUIDES[variant]}`,
  };
}

export function buildSlideDesignBrief(
  outline: SceneOutline,
  allOutlines: SceneOutline[] = [outline],
): string {
  const design = resolveSlideDesign(outline, allOutlines);
  const neighborNotes = [
    design.previousIntent ? `previous slide intent: ${design.previousIntent}` : '',
    design.nextIntent ? `next slide intent: ${design.nextIntent}` : '',
  ]
    .filter(Boolean)
    .join('; ');

  return [
    `Page ${design.pageIndex} of ${design.totalPages}`,
    `Semantic intent: ${design.intent}`,
    `Selected layout family: ${design.layout}`,
    `Selected layout variant: ${design.variant}`,
    `Content-specific visual brief: ${design.visualBrief}`,
    `Layout execution: ${design.layoutGuide}`,
    neighborNotes ? `Deck rhythm context: ${neighborNotes}.` : '',
    `Deck palette (${design.palette.name}): background ${design.palette.background}, surface ${design.palette.surface}, ink ${design.palette.ink}, muted ${design.palette.muted}, primary ${design.palette.primary}, secondary ${design.palette.secondary}, accent ${design.palette.accent}.`,
    'Keep this palette consistent, but vary composition from neighboring slides. Do not default to three equal cards unless the content is genuinely three peer categories.',
  ]
    .filter(Boolean)
    .join('\n');
}
