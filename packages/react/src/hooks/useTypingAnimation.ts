import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { positionToRowCol, isFieldEntry } from '../utils/grid';

/**
 * Hook for typing animation effect on terminal screen content.
 * Reveals characters progressively when screen content changes.
 * Also provides animated cursor position that follows the typing.
 *
 * Uses a queue-based model: incoming content updates are queued when an
 * animation is in progress, then played sequentially. This prevents
 * blinks (no mid-animation cancellation) and skips (every field entry
 * gets its own animation). Queue depth is capped to avoid falling
 * behind real-time.
 *
 * Screen transitions (large changes) always display SYNCHRONOUSLY.
 */
export function useTypingAnimation(
  content: string | null | undefined,
  enabled: boolean = true,
  typingBudgetMs: number = 100,
) {
  const FRAME_DELAY = 16; // ~60fps

  const previousContentRef = useRef('');
  const targetContentRef = useRef('');
  const contentQueueRef = useRef<string[]>([]);
  const isAnimatingRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  const [animatedContent, setAnimatedContent] = useState('');
  const [isAnimating, setIsAnimating] = useState(false);
  const [animatedCursorPos, setAnimatedCursorPos] = useState<{ row: number; col: number } | null>(null);

  const cancelAnimation = () => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  };

  const showInstant = useCallback((c: string) => {
    cancelAnimation();
    setAnimatedContent(c);
    setAnimatedCursorPos(null);
    setIsAnimating(false);
    isAnimatingRef.current = false;
    previousContentRef.current = c;
    targetContentRef.current = '';
  }, []);

  const processNextRef = useRef<(() => void) | null>(null);

  const startFieldAnimation = useCallback((fromContent: string, toContent: string) => {
    let diffStart = -1;
    let diffEnd = 0;
    const maxLen = Math.max(fromContent.length, toContent.length);
    for (let i = 0; i < maxLen; i++) {
      if ((fromContent[i] || ' ') !== (toContent[i] || ' ')) {
        if (diffStart === -1) diffStart = i;
        diffEnd = i;
      }
    }
    if (diffStart === -1) { showInstant(toContent); return; }

    setIsAnimating(true);
    isAnimatingRef.current = true;
    targetContentRef.current = toContent;

    const diffLength = diffEnd - diffStart + 1;

    const oldRegion = fromContent.substring(diffStart, diffEnd + 1);
    const isCorrection = oldRegion.replace(/[_\s\n]/g, '').length > 0;

    const finishAnimation = () => {
      setAnimatedContent(toContent);
      setIsAnimating(false);
      isAnimatingRef.current = false;
      setAnimatedCursorPos(null);
      previousContentRef.current = toContent;
      targetContentRef.current = '';
      timeoutRef.current = null;
      rafRef.current = null;
      if (processNextRef.current) processNextRef.current();
    };

    if (isCorrection) {
      const CORRECTION_BUDGET = 400;
      const removalBudget = Math.floor(CORRECTION_BUDGET * 0.4);
      const typingBudget = CORRECTION_BUDGET - removalBudget;
      const removalFrames = Math.max(2, Math.floor(removalBudget / FRAME_DELAY));
      const typingFrames = Math.max(2, Math.floor(typingBudget / FRAME_DELAY));
      const removalCPF = Math.max(1, Math.ceil(diffLength / removalFrames));
      const typingCPF = Math.max(1, Math.ceil(diffLength / typingFrames));

      let removePos = diffEnd + 1;
      let typePos = diffStart;

      const buildRemovalContent = (erasedFrom: number) => {
        const before = fromContent.substring(0, diffStart);
        const remaining = fromContent.substring(diffStart, erasedFrom);
        const erased = ' '.repeat(Math.max(0, diffEnd + 1 - erasedFrom));
        const after = toContent.substring(diffEnd + 1);
        return before + remaining + erased + after;
      };

      const buildTypingContent = (revealedUpTo: number) => {
        const before = toContent.substring(0, diffStart);
        const revealed = toContent.substring(diffStart, revealedUpTo);
        const hidden = toContent.substring(revealedUpTo, diffEnd + 1).replace(/[^\n]/g, ' ');
        const after = toContent.substring(diffEnd + 1);
        return before + revealed + hidden + after;
      };

      const animateTyping = () => {
        typePos += typingCPF;
        if (typePos >= diffEnd + 1) {
          finishAnimation();
        } else {
          setAnimatedContent(buildTypingContent(typePos));
          setAnimatedCursorPos(positionToRowCol(toContent, typePos));
          timeoutRef.current = setTimeout(() => {
            rafRef.current = requestAnimationFrame(animateTyping);
          }, FRAME_DELAY);
        }
      };

      const animateRemoval = () => {
        removePos -= removalCPF;
        if (removePos <= diffStart) {
          setAnimatedContent(buildTypingContent(diffStart));
          setAnimatedCursorPos(positionToRowCol(toContent, diffStart));
          timeoutRef.current = setTimeout(() => {
            rafRef.current = requestAnimationFrame(animateTyping);
          }, FRAME_DELAY);
        } else {
          setAnimatedContent(buildRemovalContent(removePos));
          setAnimatedCursorPos(positionToRowCol(fromContent, removePos));
          timeoutRef.current = setTimeout(() => {
            rafRef.current = requestAnimationFrame(animateRemoval);
          }, FRAME_DELAY);
        }
      };

      setAnimatedCursorPos(positionToRowCol(fromContent, diffEnd));
      setAnimatedContent(buildRemovalContent(diffEnd + 1));
      timeoutRef.current = setTimeout(() => {
        rafRef.current = requestAnimationFrame(animateRemoval);
      }, FRAME_DELAY);
    } else {
      let currentPos = diffStart;
      const totalFrames = Math.max(1, Math.floor(typingBudgetMs / FRAME_DELAY));
      const charsPerFrame = Math.max(1, Math.ceil(diffLength / totalFrames));

      setAnimatedCursorPos(positionToRowCol(toContent, diffStart));

      const buildDisplayContent = (revealedUpTo: number) => {
        const before = toContent.substring(0, diffStart);
        const revealed = toContent.substring(diffStart, revealedUpTo);
        const hidden = toContent.substring(revealedUpTo, diffEnd + 1).replace(/[^\n]/g, ' ');
        const after = toContent.substring(diffEnd + 1);
        return before + revealed + hidden + after;
      };

      const animate = () => {
        currentPos += charsPerFrame;
        if (currentPos >= diffEnd + 1) {
          finishAnimation();
        } else {
          setAnimatedContent(buildDisplayContent(currentPos));
          setAnimatedCursorPos(positionToRowCol(toContent, currentPos));
          timeoutRef.current = setTimeout(() => {
            rafRef.current = requestAnimationFrame(animate);
          }, FRAME_DELAY);
        }
      };

      setAnimatedContent(buildDisplayContent(diffStart));
      timeoutRef.current = setTimeout(() => {
        rafRef.current = requestAnimationFrame(animate);
      }, FRAME_DELAY);
    }
  }, [showInstant, typingBudgetMs]);

  processNextRef.current = () => {
    const queue = contentQueueRef.current;
    if (queue.length === 0) return;

    while (queue.length > 2) queue.shift();

    const next = queue.shift()!;
    const base = previousContentRef.current;

    if (isFieldEntry(base, next)) {
      startFieldAnimation(base, next);
    } else {
      showInstant(next);
      if (queue.length > 0 && processNextRef.current) processNextRef.current();
    }
  };

  const shouldAnimate = enabled && content && isFieldEntry(previousContentRef.current, content);
  if (!shouldAnimate && !isAnimatingRef.current && content !== previousContentRef.current) {
    previousContentRef.current = content || '';
  }

  useEffect(() => {
    if (!enabled || !content) {
      cancelAnimation();
      contentQueueRef.current = [];
      showInstant(content || '');
      previousContentRef.current = content || '';
      return;
    }

    const currentTarget = targetContentRef.current || previousContentRef.current;
    if (content === currentTarget) return;

    if (isAnimatingRef.current) {
      // Queue everything — including screen transitions — so the in-progress
      // typing animation reaches its final state before the next content is
      // shown. Previously we called showInstant() here, which cancelled the
      // animation mid-flight and made the typed field look half-filled right
      // before the screen advanced. processNextRef handles both field entries
      // (re-animate) and screen transitions (showInstant) after finishAnimation.
      contentQueueRef.current.push(content);
      if (contentQueueRef.current.length > 3) {
        contentQueueRef.current = contentQueueRef.current.slice(-2);
      }
      return;
    }

    const prev = previousContentRef.current;
    if (!isFieldEntry(prev, content)) {
      showInstant(content);
      return;
    }
    startFieldAnimation(prev, content);

    return cancelAnimation;
  }, [content, enabled, showInstant, startFieldAnimation]);

  const animationActive = isAnimatingRef.current;

  const displayedContent = useMemo(() => {
    if (!enabled || !content) return content || '';
    if (animationActive) return animatedContent;
    return content;
  }, [enabled, content, animationActive, animatedContent]);

  const effectiveCursorPos = animationActive ? animatedCursorPos : null;

  return { displayedContent, isAnimating, animatedCursorPos: effectiveCursorPos };
}
