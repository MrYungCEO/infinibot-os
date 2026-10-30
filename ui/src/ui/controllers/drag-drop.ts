/**
 * Reliable Drag & Drop Controller
 * 
 * Uses pointer events for cross-platform support (mouse + touch).
 * Handles all drag/drop state and visual feedback.
 */

export interface DragItem {
  type: 'session' | 'category';
  id: string;
  sourceCategoryId: string | null;
  sourceIndex: number;
}

export interface DropZone {
  type: 'category-header' | 'session-slot' | 'category-body' | 'uncategorized';
  categoryId: string | null;
  index: number;
  element: HTMLElement;
  rect: DOMRect;
}

export interface DragDropState {
  isDragging: boolean;
  dragItem: DragItem | null;
  dragGhost: HTMLElement | null;
  dropZones: DropZone[];
  activeDropZone: DropZone | null;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  hasMoved: boolean;
  scrollInterval: number | null;
}

type DropHandler = (item: DragItem, zone: DropZone) => void;
type StateChangeHandler = (state: DragDropState) => void;

// Minimum distance to start dragging (prevents accidental drags)
const DRAG_THRESHOLD = 5;
// Auto-scroll speed when near edges
const SCROLL_SPEED = 10;
const SCROLL_ZONE = 50;

export class DragDropController {
  private state: DragDropState = {
    isDragging: false,
    dragItem: null,
    dragGhost: null,
    dropZones: [],
    activeDropZone: null,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
    hasMoved: false,
    scrollInterval: null,
  };

  private container: HTMLElement | null = null;
  private scrollContainer: HTMLElement | null = null;
  private onDrop: DropHandler | null = null;
  private onStateChange: StateChangeHandler | null = null;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private dropIndicator: HTMLElement | null = null;

  constructor() {
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
  }

  /**
   * Initialize the controller with the sidebar container
   */
  init(
    container: HTMLElement,
    scrollContainer: HTMLElement,
    onDrop: DropHandler,
    onStateChange: StateChangeHandler
  ) {
    this.container = container;
    this.scrollContainer = scrollContainer;
    this.onDrop = onDrop;
    this.onStateChange = onStateChange;
    this.createDropIndicator();
  }

  /**
   * Clean up the controller
   */
  destroy() {
    this.cancelDrag();
    this.removeDropIndicator();
    this.container = null;
    this.scrollContainer = null;
    this.onDrop = null;
    this.onStateChange = null;
  }

  /**
   * Start tracking a potential drag on an element
   */
  startPotentialDrag(
    e: PointerEvent,
    item: DragItem,
    element: HTMLElement
  ) {
    // Ignore right-clicks
    if (e.button !== 0) return;
    
    // Store start position
    const rect = element.getBoundingClientRect();
    this.state = {
      ...this.state,
      dragItem: item,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      hasMoved: false,
    };

    // Capture pointer for reliable tracking
    element.setPointerCapture(e.pointerId);
    
    // Add document-level listeners
    document.addEventListener('pointermove', this.boundPointerMove);
    document.addEventListener('pointerup', this.boundPointerUp);
    document.addEventListener('pointercancel', this.boundPointerUp);
  }

  /**
   * Handle pointer movement during potential/active drag
   */
  private handlePointerMove(e: PointerEvent) {
    if (!this.state.dragItem) return;

    const dx = e.clientX - this.state.startX;
    const dy = e.clientY - this.state.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Start actual drag if threshold exceeded
    if (!this.state.hasMoved && distance >= DRAG_THRESHOLD) {
      this.state.hasMoved = true;
      this.state.isDragging = true;
      this.startDrag(e);
    }

    // Update drag position if dragging
    if (this.state.isDragging) {
      this.updateDragPosition(e);
      this.updateActiveDropZone(e);
      this.handleAutoScroll(e);
    }
  }

  /**
   * Handle pointer release
   */
  private handlePointerUp(e: PointerEvent) {
    document.removeEventListener('pointermove', this.boundPointerMove);
    document.removeEventListener('pointerup', this.boundPointerUp);
    document.removeEventListener('pointercancel', this.boundPointerUp);

    if (this.state.isDragging && this.state.activeDropZone && this.state.dragItem) {
      // Execute drop
      this.onDrop?.(this.state.dragItem, this.state.activeDropZone);
    }

    this.cancelDrag();
  }

  /**
   * Start the actual drag operation
   */
  private startDrag(e: PointerEvent) {
    // Collect all drop zones
    this.collectDropZones();

    // Create ghost element
    this.createDragGhost(e);

    // Add dragging class to body
    document.body.classList.add('sidebar-dragging');

    // Notify state change
    this.notifyStateChange();
  }

  /**
   * Cancel current drag operation
   */
  cancelDrag() {
    // Stop auto-scroll
    if (this.state.scrollInterval !== null) {
      clearInterval(this.state.scrollInterval);
    }

    // Remove ghost
    this.removeDragGhost();

    // Hide drop indicator
    this.hideDropIndicator();

    // Remove dragging class
    document.body.classList.remove('sidebar-dragging');

    // Reset state
    this.state = {
      isDragging: false,
      dragItem: null,
      dragGhost: null,
      dropZones: [],
      activeDropZone: null,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0,
      hasMoved: false,
      scrollInterval: null,
    };

    this.notifyStateChange();
  }

  /**
   * Collect all available drop zones in the sidebar
   */
  private collectDropZones() {
    if (!this.container) return;

    const zones: DropZone[] = [];

    // Category headers (for reordering categories)
    const categoryHeaders = this.container.querySelectorAll<HTMLElement>('[data-drop-category-header]');
    categoryHeaders.forEach((el, index) => {
      const categoryId = el.dataset.dropCategoryHeader || null;
      zones.push({
        type: 'category-header',
        categoryId,
        index,
        element: el,
        rect: el.getBoundingClientRect(),
      });
    });

    // Session slots (for reordering sessions within categories)
    const sessionSlots = this.container.querySelectorAll<HTMLElement>('[data-drop-session-slot]');
    sessionSlots.forEach(el => {
      const categoryId = el.dataset.categoryId || null;
      const index = parseInt(el.dataset.dropIndex || '0', 10);
      zones.push({
        type: 'session-slot',
        categoryId,
        index,
        element: el,
        rect: el.getBoundingClientRect(),
      });
    });

    // Category bodies (for dropping into categories)
    const categoryBodies = this.container.querySelectorAll<HTMLElement>('[data-drop-category-body]');
    categoryBodies.forEach(el => {
      const categoryId = el.dataset.dropCategoryBody || null;
      zones.push({
        type: 'category-body',
        categoryId,
        index: -1, // Will append to end
        element: el,
        rect: el.getBoundingClientRect(),
      });
    });

    // Uncategorized area
    const uncategorized = this.container.querySelector<HTMLElement>('[data-drop-uncategorized]');
    if (uncategorized) {
      zones.push({
        type: 'uncategorized',
        categoryId: null,
        index: -1,
        element: uncategorized,
        rect: uncategorized.getBoundingClientRect(),
      });
    }

    this.state.dropZones = zones;
  }

  /**
   * Update which drop zone is currently active based on pointer position
   */
  private updateActiveDropZone(e: PointerEvent) {
    const x = e.clientX;
    const y = e.clientY;

    // Find the best matching drop zone
    let bestZone: DropZone | null = null;
    let bestDistance = Infinity;

    for (const zone of this.state.dropZones) {
      // Skip the zone if it's the dragged item itself
      if (zone.type === 'session-slot' && 
          this.state.dragItem?.type === 'session' &&
          zone.element.dataset.sessionId === this.state.dragItem.id) {
        continue;
      }

      // Check if pointer is within zone bounds (with padding)
      const rect = zone.rect;
      const padding = 10;
      
      if (x >= rect.left - padding && x <= rect.right + padding &&
          y >= rect.top - padding && y <= rect.bottom + padding) {
        
        // Calculate distance to zone center
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = Math.sqrt(
          Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2)
        );

        // Prefer slot zones over body zones when close
        const priority = zone.type === 'session-slot' ? 0 : 1;
        const effectiveDistance = distance + priority * 100;

        if (effectiveDistance < bestDistance) {
          bestDistance = effectiveDistance;
          bestZone = zone;
        }
      }
    }

    // Update active zone if changed
    if (bestZone !== this.state.activeDropZone) {
      // Remove highlight from old zone
      if (this.state.activeDropZone) {
        this.state.activeDropZone.element.classList.remove('drop-active');
      }

      // Add highlight to new zone
      if (bestZone) {
        bestZone.element.classList.add('drop-active');
        this.showDropIndicator(bestZone);
      } else {
        this.hideDropIndicator();
      }

      this.state.activeDropZone = bestZone;
      this.notifyStateChange();
    }
  }

  /**
   * Create the drag ghost element
   */
  private createDragGhost(e: PointerEvent) {
    if (!this.state.dragItem || !this.container) return;

    // Find the source element
    const selector = this.state.dragItem.type === 'session' 
      ? `[data-session-id="${this.state.dragItem.id}"]`
      : `[data-category-id="${this.state.dragItem.id}"]`;
    
    const sourceEl = this.container.querySelector<HTMLElement>(selector);
    if (!sourceEl) return;

    // Clone the element
    const ghost = sourceEl.cloneNode(true) as HTMLElement;
    ghost.classList.add('drag-ghost');
    ghost.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 10000;
      width: ${sourceEl.offsetWidth}px;
      opacity: 0.9;
      transform: rotate(2deg) scale(1.02);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 2px var(--gold, var(--g-primary));
      border-radius: 6px;
      transition: transform 0.1s ease, box-shadow 0.1s ease;
    `;

    document.body.appendChild(ghost);
    this.state.dragGhost = ghost;

    // Position it
    this.updateDragPosition(e);

    // Mark source as being dragged
    sourceEl.classList.add('being-dragged');
  }

  /**
   * Update drag ghost position
   */
  private updateDragPosition(e: PointerEvent) {
    if (!this.state.dragGhost) return;

    const x = e.clientX - this.state.offsetX;
    const y = e.clientY - this.state.offsetY;

    this.state.dragGhost.style.left = `${x}px`;
    this.state.dragGhost.style.top = `${y}px`;
  }

  /**
   * Remove the drag ghost element
   */
  private removeDragGhost() {
    if (this.state.dragGhost) {
      this.state.dragGhost.remove();
      this.state.dragGhost = null;
    }

    // Remove being-dragged class from all elements
    document.querySelectorAll('.being-dragged').forEach(el => {
      el.classList.remove('being-dragged');
    });
  }

  /**
   * Create the drop indicator element
   */
  private createDropIndicator() {
    if (this.dropIndicator) return;

    this.dropIndicator = document.createElement('div');
    this.dropIndicator.className = 'drop-indicator';
    this.dropIndicator.style.cssText = `
      position: fixed;
      height: 3px;
      background: var(--gold, var(--g-primary));
      border-radius: 2px;
      z-index: 9999;
      pointer-events: none;
      display: none;
      box-shadow: 0 0 8px var(--gold, var(--g-primary)), 0 0 16px color-mix(in srgb, var(--g-primary) 50%, transparent);
    `;

    // Add pulsing dots at the ends
    const leftDot = document.createElement('div');
    const rightDot = document.createElement('div');
    const dotStyle = `
      position: absolute;
      width: 8px;
      height: 8px;
      background: var(--gold, var(--g-primary));
      border-radius: 50%;
      top: 50%;
      transform: translateY(-50%);
      animation: dropIndicatorPulse 0.8s ease-in-out infinite;
    `;
    leftDot.style.cssText = dotStyle + 'left: -4px;';
    rightDot.style.cssText = dotStyle + 'right: -4px;';

    this.dropIndicator.appendChild(leftDot);
    this.dropIndicator.appendChild(rightDot);

    document.body.appendChild(this.dropIndicator);
  }

  /**
   * Show the drop indicator at a zone
   */
  private showDropIndicator(zone: DropZone) {
    if (!this.dropIndicator) return;

    const rect = zone.rect;
    let top: number;
    let left: number;
    let width: number;

    if (zone.type === 'session-slot' || zone.type === 'category-header') {
      // Show line above the element
      top = rect.top - 2;
      left = rect.left + 8;
      width = rect.width - 16;
    } else {
      // Show line at bottom of container
      top = rect.bottom - 2;
      left = rect.left + 12;
      width = rect.width - 24;
    }

    this.dropIndicator.style.top = `${top}px`;
    this.dropIndicator.style.left = `${left}px`;
    this.dropIndicator.style.width = `${width}px`;
    this.dropIndicator.style.display = 'block';
  }

  /**
   * Hide the drop indicator
   */
  private hideDropIndicator() {
    if (this.dropIndicator) {
      this.dropIndicator.style.display = 'none';
    }
  }

  /**
   * Remove the drop indicator element
   */
  private removeDropIndicator() {
    if (this.dropIndicator) {
      this.dropIndicator.remove();
      this.dropIndicator = null;
    }
  }

  /**
   * Handle auto-scrolling when near edges
   */
  private handleAutoScroll(e: PointerEvent) {
    if (!this.scrollContainer) return;

    const rect = this.scrollContainer.getBoundingClientRect();
    const y = e.clientY;

    // Calculate scroll direction and speed
    let scrollDelta = 0;

    if (y < rect.top + SCROLL_ZONE) {
      // Near top - scroll up
      const proximity = (rect.top + SCROLL_ZONE - y) / SCROLL_ZONE;
      scrollDelta = -SCROLL_SPEED * proximity;
    } else if (y > rect.bottom - SCROLL_ZONE) {
      // Near bottom - scroll down
      const proximity = (y - (rect.bottom - SCROLL_ZONE)) / SCROLL_ZONE;
      scrollDelta = SCROLL_SPEED * proximity;
    }

    // Start or stop auto-scroll
    if (scrollDelta !== 0 && this.state.scrollInterval === null) {
      this.state.scrollInterval = window.setInterval(() => {
        if (this.scrollContainer) {
          this.scrollContainer.scrollTop += scrollDelta;
          // Refresh drop zone rects after scroll
          this.collectDropZones();
        }
      }, 16);
    } else if (scrollDelta === 0 && this.state.scrollInterval !== null) {
      clearInterval(this.state.scrollInterval);
      this.state.scrollInterval = null;
    }
  }

  /**
   * Notify parent of state change
   */
  private notifyStateChange() {
    this.onStateChange?.({ ...this.state });
  }

  /**
   * Get current drag state
   */
  getState(): DragDropState {
    return { ...this.state };
  }

  /**
   * Check if currently dragging
   */
  isDragging(): boolean {
    return this.state.isDragging;
  }

  /**
   * Get the dragged item
   */
  getDragItem(): DragItem | null {
    return this.state.dragItem;
  }

  /**
   * Get the active drop zone
   */
  getActiveDropZone(): DropZone | null {
    return this.state.activeDropZone;
  }
}

// Global singleton instance
let globalController: DragDropController | null = null;

export function getDragDropController(): DragDropController {
  if (!globalController) {
    globalController = new DragDropController();
  }
  return globalController;
}

// Add keyframes for the pulse animation
const style = document.createElement('style');
style.textContent = `
  @keyframes dropIndicatorPulse {
    0%, 100% { transform: translateY(-50%) scale(1); opacity: 1; }
    50% { transform: translateY(-50%) scale(1.3); opacity: 0.7; }
  }
  
  .sidebar-dragging {
    cursor: grabbing !important;
    user-select: none !important;
  }
  
  .sidebar-dragging * {
    cursor: grabbing !important;
  }
  
  .being-dragged {
    opacity: 0.3 !important;
    background: color-mix(in srgb, var(--g-primary) 10%, transparent) !important;
  }
  
  .drop-active {
    background: color-mix(in srgb, var(--g-primary) 15%, transparent) !important;
  }
  
  .drag-ghost {
    animation: ghostAppear 0.15s ease-out;
  }
  
  @keyframes ghostAppear {
    from {
      opacity: 0;
      transform: rotate(0deg) scale(0.95);
    }
    to {
      opacity: 0.9;
      transform: rotate(2deg) scale(1.02);
    }
  }
`;
if (typeof document !== 'undefined') {
  document.head.appendChild(style);
}
