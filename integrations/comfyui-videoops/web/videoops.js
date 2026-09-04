import { app } from '../../../scripts/app.js';
import { PINNED_FRONTEND_REF, createVideoOpsBridge } from './bridge-runtime.js';

let bridge;
let nativeControlObserver;

function disableNativeQueueControls() {
  const selectors = [
    '[data-testid="queue-button"]',
    '#queue-button',
    '[data-testid="queue-mode-menu-trigger"]',
  ];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      element.setAttribute('disabled', 'true');
      element.setAttribute('aria-disabled', 'true');
      element.setAttribute('data-videoops-native-disabled', 'true');
      element.setAttribute(
        'title',
        'Native ComfyUI queue is disabled. Use VideoOps Managed Run.',
      );
      if ('disabled' in element) element.disabled = true;
    }
  }
}

function startNativeQueueGate() {
  disableNativeQueueControls();
  nativeControlObserver = new MutationObserver(disableNativeQueueControls);
  nativeControlObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function stopNativeQueueGate() {
  nativeControlObserver?.disconnect();
  nativeControlObserver = undefined;
}

function statusDetail(state) {
  const latest = state.latestStatus;
  if (!latest) return 'Managed run status';
  const evaluation = latest.evaluation;
  const evaluationText =
    typeof evaluation === 'string'
      ? evaluation
      : evaluation && typeof evaluation === 'object'
        ? String(evaluation.status ?? 'reported')
        : undefined;
  const activeRunCount =
    evaluation && typeof evaluation === 'object'
      ? evaluation.activeRunCount
      : undefined;
  const openFindingCount =
    evaluation && typeof evaluation === 'object'
      ? evaluation.openFindingCount
      : undefined;
  const budgetHeadroom =
    evaluation && typeof evaluation === 'object'
      ? evaluation.budgetHeadroom
      : undefined;
  const executorReadiness =
    evaluation && typeof evaluation === 'object'
      ? evaluation.executorReadiness
      : undefined;
  return [
    `Run ${latest.runId}`,
    `Status: ${latest.status}`,
    evaluationText ? `Evaluation: ${evaluationText}` : undefined,
    typeof executorReadiness === 'string'
      ? `Executor: ${executorReadiness}`
      : undefined,
    typeof activeRunCount === 'number'
      ? `Active: ${activeRunCount}`
      : undefined,
    typeof openFindingCount === 'number'
      ? `Findings: ${openFindingCount}`
      : undefined,
    typeof budgetHeadroom === 'number'
      ? `Budget headroom: $${budgetHeadroom.toFixed(2)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

function renderStatusPanel(container, state) {
  container.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = 'VideoOps managed status';
  const status = document.createElement('p');
  status.textContent = state.latestStatus
    ? statusDetail(state)
    : state.connected
      ? 'Ready for a managed run.'
      : 'Connecting to Studio…';
  const trace = document.createElement('p');
  trace.textContent = `Pinned frontend: ${PINNED_FRONTEND_REF}`;
  const limitation = document.createElement('p');
  limitation.textContent =
    'Node durations: not recorded in the durable Phase 7 feed.';
  container.append(heading, status, trace, limitation);
}

function makeStatusTab() {
  return {
    id: 'h3-videoops-status',
    title: 'VideoOps',
    targetPanel: 'terminal',
    type: 'custom',
    render(container) {
      const previous = container.__videoOpsStatusCleanup;
      previous?.();
      renderStatusPanel(
        container,
        bridge?.getState?.() ?? { connected: false },
      );
      if (bridge?.subscribe) {
        container.__videoOpsStatusCleanup = bridge.subscribe((state) =>
          renderStatusPanel(container, state),
        );
      }
    },
    destroy() {
      // The container owns the subscription; the bridge owns the iframe.
    },
  };
}

const badge = {
  // topbarBadges are static metadata in the pinned frontend. Live values are
  // supplied through the supported bottom-panel feed; the badge identifies
  // the managed execution mode without pretending its snapshot is reactive.
  text: 'VideoOps · managed',
  label: 'MANAGED',
  variant: 'info',
  icon: 'pi pi-shield',
  tooltip: 'Managed execution · live readiness and budget details in VideoOps',
};

app.registerExtension({
  name: 'h3.videoops.plugin',
  topbarBadges: [badge],
  actionBarButtons: [
    {
      icon: 'icon-[lucide--play-circle]',
      label: 'Managed Run',
      tooltip: 'Managed Run',
      class: 'h3-videoops-managed-run',
      onClick: () => void bridge?.exportCurrentWorkflow?.(),
    },
  ],
  bottomPanelTabs: [makeStatusTab()],
  async setup(comfyApp) {
    bridge = createVideoOpsBridge({ app: comfyApp });
    startNativeQueueGate();
    // The only genuine end of a bridge session is the page going away.
    window.addEventListener(
      'pagehide',
      () => {
        bridge?.destroy();
        stopNativeQueueGate();
      },
      { once: true },
    );
    comfyApp.extensionManager.registerSidebarTab({
      id: 'h3-videoops',
      title: 'VideoOps',
      label: 'VideoOps',
      tooltip: 'Toggle VideoOps Sidebar',
      icon: 'icon-[lucide--clapperboard]',
      type: 'custom',
      render(container) {
        bridge?.attach(container);
      },
      destroy() {
        // ComfyUI destroys a custom sidebar tab whenever the user switches to
        // another tab. Only the mount ends here. Tearing down the bridge would
        // leave `attach` returning false on every later render, blanking the
        // panel and killing Managed Run until a full reload; stopping the queue
        // gate would re-enable native queueing, which must stay disabled for as
        // long as the plugin is loaded.
        bridge?.detach();
      },
    });
  },
});
