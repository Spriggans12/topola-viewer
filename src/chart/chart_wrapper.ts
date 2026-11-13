import {max, min} from 'd3-array';
import {interpolateNumber} from 'd3-interpolate';
import {BaseType, select, Selection} from 'd3-selection';
import 'd3-transition';
import {
  D3ZoomEvent,
  zoom,
  ZoomBehavior,
  ZoomedElementBaseType,
  zoomTransform,
} from 'd3-zoom';
import {IntlShape} from 'react-intl';
import {
  ChartHandle,
  ChartInfo,
  CollapsedSets,
  createChart,
  ExpanderDirection,
  ExpanderState,
  getChildExpanderId,
  toggleExpander,
} from 'topola';
import {
  chartColors,
  ChartProps,
  getChartType,
  getRendererType,
} from './chart_types';

/** How much to zoom when using the +/- buttons. */
const ZOOM_FACTOR = 1.3;

/**
 * Longest time to wait for the end of an animation. topola only reports the
 * end of transitions that complete: when they are interrupted by another
 * render (e.g. after a click on a [+]/[-] expander), the end never comes.
 */
const MAX_ANIMATION_MS = 2000;

/** Parses an SVG `translate(x, y)` transform. Returns [0, 0] otherwise. */
function parseTranslate(transform: string | null): [number, number] {
  const match = /translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)\s*\)/.exec(
    transform || '',
  );
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

/** Position of a chart node, as stored by d3 on its elements. */
interface NodePosition {
  id?: string;
  x: number;
  y: number;
  data?: {
    parentId?: string;
    indiParentNodeId?: string;
    spouseParentNodeId?: string;
    indi?: {id: string; expander?: ExpanderState};
    spouse?: {expander?: ExpanderState};
    family?: {expander?: ExpanderState};
  };
}

/** Part of the chart shown again by a [+] button. */
type RevealedBranch = 'indiParents' | 'spouseParents' | 'children';

/**
 * A node whose position on screen should be kept after the next render, given
 * by its position in the scrollable container.
 */
interface ScrollAnchor {
  nodeId: string;
  x: number;
  y: number;
  /** Set when the button expanded a branch. */
  revealed?: RevealedBranch;
}

/** Returns the nodes of the branch shown again under or above a node. */
function getRevealedNodes(
  nodes: NodePosition[],
  node: NodePosition,
  revealed: RevealedBranch,
): NodePosition[] {
  if (revealed === 'children') {
    return nodes.filter((other) => other.data?.parentId === node.id);
  }
  const parentId =
    revealed === 'indiParents'
      ? node.data?.indiParentNodeId
      : node.data?.spouseParentNodeId;
  return nodes.filter((other) => parentId && other.id === parentId);
}

/**
 * Called when the view is dragged with the mouse.
 *
 * @param size the size of the chart
 */
function zoomed(
  size: [number, number],
  event: D3ZoomEvent<ZoomedElementBaseType, unknown>,
) {
  const parent = select('#svgContainer').node() as Element;

  const scale = event.transform.k;
  const offsetX = max([0, (parent.clientWidth - size[0] * scale) / 2]);
  const offsetY = max([0, (parent.clientHeight - size[1] * scale) / 2]);
  select('#chartSvg')
    .attr('width', size[0] * scale)
    .attr('height', size[1] * scale)
    .attr('transform', `translate(${offsetX}, ${offsetY})`);
  select('#chart').attr('transform', `scale(${scale})`);

  parent.scrollLeft = -event.transform.x;
  parent.scrollTop = -event.transform.y;
}

/** Called when the scrollbars are used. */
function scrolled() {
  const parent = select('#svgContainer').node() as Element;
  const x = parent.scrollLeft + parent.clientWidth / 2;
  const y = parent.scrollTop + parent.clientHeight / 2;
  const scale = zoomTransform(parent).k;
  select(parent).call(zoom().translateTo, x / scale, y / scale);
}

/** Returns the element's usable width and height by subtracting the assumed scrollbar size. */
function getScrollbarAwareSize(
  element: Element,
  scrollbarSize = 20,
): [number, number] {
  const htmlElement = element as HTMLElement;
  return [
    htmlElement.clientWidth - scrollbarSize,
    htmlElement.clientHeight - scrollbarSize,
  ];
}

/**
 * Calculates the allowed zoom scale range.
 * Sets the minimum scale so the chart cannot zoom out beyond full visibility,
 * and fixes the maximum scale at 2.
 */
function calculateScaleExtent(
  parent: Element,
  scale: number,
  chartInfo: ChartInfo,
): [number, number] {
  const [availWidth, availHeight] = getScrollbarAwareSize(parent);

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const zoomOutFactor = min([
    1,
    scale,
    availWidth / chartInfo.size[0],
    availHeight / chartInfo.size[1],
  ])!;

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return [max([0.1, zoomOutFactor])!, 2];
}

/**
 * Returns the position, in the scrollable container, of the given node, as
 * currently drawn.
 */
function getScrollAnchor(nodeId: string): ScrollAnchor | undefined {
  const controls = select('#chart')
    .selectAll<Element, NodePosition>('g.controls')
    .filter((node) => node.id === nodeId)
    .node();
  if (!controls) {
    return undefined;
  }
  // The transitions to the new layout have not started yet: the transforms
  // still describe what is on the screen.
  const [nodeX, nodeY] = parseTranslate(controls.getAttribute('transform'));
  // topola draws the chart in a group moved by the chart's origin.
  const [originX, originY] = parseTranslate(
    select('#chart > g').attr('transform'),
  );
  const [offsetX, offsetY] = parseTranslate(
    select('#chartSvg').attr('transform'),
  );
  const parent = select('#svgContainer').node() as Element;
  const scale = zoomTransform(parent).k;
  return {
    nodeId,
    x: offsetX + (originX + nodeX) * scale,
    y: offsetY + (originY + nodeY) * scale,
  };
}

/**
 * Returns the node to keep in place when a child is hidden: the sibling
 * nearest to it on the screen, or its parents if it has no siblings. In the
 * relatives chart, the parents can be far from their children.
 */
function getHiddenChildAnchor(
  nodeId: string,
  parentId: string,
  childId: string,
): ScrollAnchor | undefined {
  const child = getScrollAnchor(nodeId);
  const siblings = select('#chart')
    .selectAll<Element, NodePosition>('g.controls')
    .data()
    .flatMap((other) => {
      const isSibling =
        other.data?.parentId === parentId &&
        // Other marriages of the hidden child have the same parent.
        other.data.indi?.id !== childId;
      const anchor = isSibling && other.id && getScrollAnchor(other.id);
      return anchor ? [anchor] : [];
    });
  if (!child || !siblings.length) {
    return getScrollAnchor(parentId);
  }
  const distance = (anchor: ScrollAnchor) =>
    Math.hypot(anchor.x - child.x, anchor.y - child.y);
  return siblings.reduce((nearest, anchor) =>
    distance(anchor) < distance(nearest) ? anchor : nearest,
  );
}

export class ChartWrapper {
  private chart?: ChartHandle;
  /** Animation is in progress. */
  private animating = false;
  /** Rendering is required after the current animation finishes. */
  private rerenderRequired = false;
  /** The d3 zoom behavior object. */
  private zoomBehavior?: ZoomBehavior<Element, unknown>;
  /** Props that will be used for rerendering. */
  private rerenderProps?: ChartProps;
  private rerenderResetPosition?: boolean;
  private rerenderRefresh?: boolean;
  /** Last rendered props, used to refresh after an expander is clicked. */
  private lastProps?: ChartProps;
  private lastIntl?: IntlShape;
  /** Incremented on each render, to ignore the end of older animations. */
  private renderCount = 0;
  /** Node to keep in place after the next refresh. */
  private scrollAnchor?: ScrollAnchor;
  /**
   * Collapsed branches. They are kept here, and given to each new chart
   * handle, so that changing a setting, which creates a new chart, does not
   * expand them all again.
   */
  private readonly collapsed: CollapsedSets = {
    collapsedIndi: new Set<string>(),
    collapsedSpouse: new Set<string>(),
    collapsedFamily: new Set<string>(),
    collapsedChild: new Set<string>(),
  };

  zoom(factor: number) {
    const parent = select('#svgContainer') as Selection<
      Element,
      unknown,
      BaseType,
      unknown
    >;
    this.zoomBehavior?.scaleBy(parent, factor);
  }

  /**
   * Renders the chart or performs a transition animation to a new state.
   * If indiInfo is not given, it means that it is the initial render and no
   * animation is performed.
   */
  renderChart(
    props: ChartProps,
    intl: IntlShape,
    args: {
      initialRender: boolean;
      resetPosition: boolean;
      /** Rerender with the same props, e.g. after a branch was collapsed. */
      refresh?: boolean;
    } = {
      initialRender: false,
      resetPosition: false,
    },
  ) {
    this.lastProps = props;
    this.lastIntl = intl;

    // Nothing changed — the SVG is already correct. Skip re-render.
    // This prevents repeated full D3 layout passes (500ms+ each) that happen
    // when React re-renders for unrelated state changes.
    if (!args.initialRender && !args.resetPosition && !args.refresh) {
      return;
    }

    // Wait for animation to finish if animation is in progress.
    if (!args.initialRender && this.animating) {
      this.rerenderRequired = true;
      this.rerenderProps = props;
      this.rerenderResetPosition =
        args.resetPosition || !!this.rerenderResetPosition;
      this.rerenderRefresh = args.refresh || !!this.rerenderRefresh;
      return;
    }

    // Freeze changing selection after initial rendering.
    if (!args.initialRender && !args.refresh && props.freezeAnimation) {
      return;
    }

    if (args.initialRender || !this.chart) {
      (select('#chart').node() as HTMLElement).innerHTML = '';
      this.chart = createChart({
        json: props.data,
        chartType: getChartType(props.chartType),
        renderer: getRendererType(props.chartType),
        svgSelector: '#chart',
        indiCallback: (info) => {
          // ths is called when an individual is selected in the chart
          if (info.modifiers?.shiftKey) {
            // If the shift key is pressed, we just update the details tab without changing the selection in the chart.
            // This allows users to quickly view details of multiple individuals without losing their place in the chart.
            props.onDetailSelection(info);
          } else {
            // If the shift key is not pressed, we update the selection in the chart as usual.
            props.onSelection(info);
          }
        },
        colors:
          props.colors !== undefined
            ? chartColors.get(props.colors)
            : undefined,
        animate: true,
        updateSvgSize: false,
        locale: intl.locale,
        expanders: true,
      });
      this.useCollapsedBranches();
      // Handle clicks on the [+]/[-] expanders here, before topola does.
      select('#chart').on(
        'click.expanders',
        (event: MouseEvent) => this.onExpanderClick(event),
        {capture: true},
      );
    } else {
      this.chart.setData(props.data);
    }
    const chartInfo = this.chart.render({
      startIndi: props.selection.id,
      baseGeneration: props.selection.generation,
    });
    const svg = select('#chartSvg');
    const parent = select('#svgContainer').node() as Element;
    const scale = zoomTransform(parent).k;
    const extent: [number, number] = calculateScaleExtent(
      parent,
      scale,
      chartInfo,
    );

    this.zoomBehavior = zoom()
      .scaleExtent(extent)
      .translateExtent([[0, 0], chartInfo.size])
      .on('zoom', (event) => zoomed(chartInfo.size, event));

    select(parent).on('scroll', scrolled).call(this.zoomBehavior);

    const scrollTopTween = (scrollTop: number) => {
      return () => {
        const i = interpolateNumber(parent.scrollTop, scrollTop);
        return (t: number) => {
          parent.scrollTop = i(t);
        };
      };
    };
    const scrollLeftTween = (scrollLeft: number) => {
      return () => {
        const i = interpolateNumber(parent.scrollLeft, scrollLeft);
        return (t: number) => {
          parent.scrollLeft = i(t);
        };
      };
    };

    const dx = parent.clientWidth / 2 - chartInfo.origin[0] * scale;
    const dy = parent.clientHeight / 2 - chartInfo.origin[1] * scale;
    const offsetX = max([
      0,
      (parent.clientWidth - chartInfo.size[0] * scale) / 2,
    ]);
    const offsetY = max([
      0,
      (parent.clientHeight - chartInfo.size[1] * scale) / 2,
    ]);
    const svgTransition = svg.transition().delay(200).duration(500);
    const transition = args.initialRender ? svg : svgTransition;
    transition.attr('transform', `translate(${offsetX}, ${offsetY})`);
    transition.attr('width', chartInfo.size[0] * scale);
    transition.attr('height', chartInfo.size[1] * scale);
    // After a click on a [+]/[-] button, keep the clicked node where it was on
    // the screen, so that the branch appears or disappears around it.
    const anchor = args.refresh ? this.scrollAnchor : undefined;
    this.scrollAnchor = undefined;
    const allNodes = anchor
      ? select('#chart').selectAll<Element, NodePosition>('g.controls').data()
      : [];
    const anchorNode = anchor
      ? allNodes.find((node) => node.id === anchor.nodeId)
      : undefined;
    if (anchor && anchorNode && !args.resetPosition) {
      // Position of a chart point in the scrollable container.
      const toContainer = (x: number, y: number) => [
        (offsetX ?? 0) + (chartInfo.origin[0] + x) * scale,
        (offsetY ?? 0) + (chartInfo.origin[1] + y) * scale,
      ];
      const [anchorX, anchorY] = toContainer(anchorNode.x, anchorNode.y);
      let scrollLeft = parent.scrollLeft + anchorX - anchor.x;
      let scrollTop = parent.scrollTop + anchorY - anchor.y;

      // In a wide chart, the branch shown again by a [+] button can be far
      // from the button. If it would be out of view, center it.
      const revealed = anchor.revealed
        ? getRevealedNodes(allNodes, anchorNode, anchor.revealed)
        : [];
      if (revealed.length) {
        const [revealedX, revealedY] = toContainer(
          revealed.reduce((sum, node) => sum + node.x, 0) / revealed.length,
          revealed.reduce((sum, node) => sum + node.y, 0) / revealed.length,
        );
        const margin = 100;
        if (
          revealedX < scrollLeft + margin ||
          revealedX > scrollLeft + parent.clientWidth - margin
        ) {
          scrollLeft = revealedX - parent.clientWidth / 2;
        }
        if (
          revealedY < scrollTop + margin ||
          revealedY > scrollTop + parent.clientHeight - margin
        ) {
          scrollTop = revealedY - parent.clientHeight / 2;
        }
      }
      svgTransition
        .tween('scrollLeft', scrollLeftTween(scrollLeft))
        .tween('scrollTop', scrollTopTween(scrollTop));
    }
    if (args.resetPosition) {
      if (args.initialRender) {
        parent.scrollLeft = -dx;
        parent.scrollTop = -dy;
      } else {
        svgTransition
          .tween('scrollLeft', scrollLeftTween(-dx))
          .tween('scrollTop', scrollTopTween(-dy));
      }
    }

    // After the animation is finished, rerender the chart if required.
    this.animating = true;
    const renderId = ++this.renderCount;
    Promise.race([
      chartInfo.animationPromise,
      new Promise<void>((resolve) => setTimeout(resolve, MAX_ANIMATION_MS)),
    ]).then(() => {
      if (renderId !== this.renderCount) {
        // A newer render has started in the meantime.
        return;
      }
      this.animating = false;
      if (this.rerenderRequired) {
        this.rerenderRequired = false;
        // Use `this.rerenderProps` instead of the props in scope because
        // the props may have been updated in the meantime.
        if (this.rerenderProps) {
          const resetPosition = !!this.rerenderResetPosition;
          const refresh = !!this.rerenderRefresh;
          this.rerenderResetPosition = false;
          this.rerenderRefresh = false;
          this.renderChart(this.rerenderProps, intl, {
            initialRender: false,
            resetPosition,
            refresh,
          });
        } else {
          console.error(
            'Rerender required after animation, but rerenderProps was not set.',
          );
        }
      }
    });
  }

  /**
   * Handles a click on a [+]/[-] expander.
   *
   * topola would toggle the branch and rerender the chart by itself, without
   * updating the SVG size, zoom extent and scroll position managed here. A
   * second render to update them would interrupt the fade-in of the boxes
   * that appear, which would then stay invisible. Instead, the branch is
   * toggled here and the chart is rendered once, as for any other change.
   */
  private onExpanderClick(event: MouseEvent) {
    const expander = (event.target as Element | null)?.closest?.('.expander');
    if (!expander || !this.usesCollapsedBranches()) {
      // Not an expander, or a topola version that keeps its state elsewhere:
      // let topola handle the click.
      return;
    }
    event.stopPropagation();
    const node = select<Element, NodePosition>(expander).datum();
    if (!node?.id) {
      return;
    }
    const classes = expander.classList;
    if (classes.contains('childExpander')) {
      const parentId = node.data?.parentId;
      const childId = node.data?.indi?.id;
      if (!parentId || !childId) {
        return;
      }
      toggleExpander(
        this.collapsed,
        getChildExpanderId(parentId, childId),
        ExpanderDirection.CHILD,
      );
      this.scrollAnchor = getHiddenChildAnchor(node.id, parentId, childId);
      this.refresh();
      return;
    }
    const direction = classes.contains('familyExpander')
      ? ExpanderDirection.FAMILY
      : classes.contains('spouseExpander')
        ? ExpanderDirection.SPOUSE
        : ExpanderDirection.INDI;
    const entry =
      direction === ExpanderDirection.FAMILY
        ? node.data?.family
        : direction === ExpanderDirection.SPOUSE
          ? node.data?.spouse
          : node.data?.indi;
    // A [+] shows a branch again (for a family, all its hidden children).
    const expanding = entry?.expander === ExpanderState.PLUS;
    toggleExpander(this.collapsed, node.id, direction);
    const anchor = getScrollAnchor(node.id);
    if (anchor && expanding) {
      anchor.revealed =
        direction === ExpanderDirection.FAMILY
          ? 'children'
          : direction === ExpanderDirection.SPOUSE
            ? 'spouseParents'
            : 'indiParents';
    }
    this.scrollAnchor = anchor;
    this.refresh();
  }

  /** Expands all the collapsed branches, from the next render. */
  expandAll() {
    this.collapsed.collapsedIndi.clear();
    this.collapsed.collapsedSpouse.clear();
    this.collapsed.collapsedFamily.clear();
    this.collapsed.collapsedChild.clear();
  }

  /** Whether the current chart handle keeps the collapsed branches. */
  private usesCollapsedBranches() {
    const handle = this.chart as unknown as Partial<CollapsedSets> | undefined;
    return !!(
      handle?.collapsedIndi &&
      handle.collapsedSpouse &&
      handle.collapsedFamily &&
      handle.collapsedChild
    );
  }

  /** Makes the current chart handle use the collapsed branches kept here. */
  private useCollapsedBranches() {
    if (this.usesCollapsedBranches()) {
      Object.assign(this.chart as object, this.collapsed);
    }
  }

  /** Rerenders the chart with the last props, keeping the scroll position. */
  private refresh() {
    if (this.lastProps && this.lastIntl) {
      this.renderChart(this.lastProps, this.lastIntl, {
        initialRender: false,
        resetPosition: false,
        refresh: true,
      });
    }
  }
}

export {ZOOM_FACTOR};
