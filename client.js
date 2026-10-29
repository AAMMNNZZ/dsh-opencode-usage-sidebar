/**
 * Browser half of the OpenCode subscription usage bundle.
 *
 * Renders a three-row usage card in the sidebar foot (`sidebar.footer.action`,
 * the additive list directly above the Settings row), so the numbers stay
 * visible on every page instead of only inside one Session. The data comes
 * from the Host route `/dsh-opencode-usage/api/usage`; the provider key never
 * reaches this module.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-usage-sidebar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = 'opencodeUsage';
    const ENDPOINT = '/dsh-opencode-usage/api/usage';
    const STREAM = '/dsh-opencode-usage/api/stream';
    const MIN_POLL_SEC = 15;
    const RETRY_MS = 60_000;
    /** Minimum gap between two wake-up refreshes, so a burst costs one request. */
    const WAKE_GAP_MS = 1_000;

    const DICTS = {
      zh: {
        'usage.title': 'OpenCode 订阅用量',
        'usage.rolling': '5 小时',
        'usage.weekly': '本周',
        'usage.monthly': '本月',
        'usage.refresh': '刷新用量',
        'usage.reset': '重置',
        'usage.unavailable': '用量暂不可用',
        'usage.refreshIn': '距刷新',
        'usage.hourUnit': '小时',
        'usage.hourShort': '时',
        'usage.minuteUnit': '分',
        'usage.secondUnit': '秒',
        'usage.refreshing': '即将刷新',
      },
      en: {
        'usage.title': 'OpenCode subscription usage',
        'usage.rolling': '5-hour',
        'usage.weekly': 'Week',
        'usage.monthly': 'Month',
        'usage.refresh': 'Refresh usage',
        'usage.reset': 'Resets',
        'usage.unavailable': 'Usage unavailable',
        'usage.refreshIn': 'Refresh in',
        'usage.hourUnit': 'h',
        'usage.hourShort': 'h',
        'usage.minuteUnit': 'm',
        'usage.secondUnit': 's',
        'usage.refreshing': 'Refreshing soon',
      },
    };

    /**
     * Translate without the locale service, so a missing registry still renders
     * readable text instead of throwing inside the slot.
     * @param key - dictionary key.
     * @returns the English text, then the key itself.
     */
    function fallbackTranslate(key) {
      return DICTS.en[key] ?? key;
    }

    /**
     * Two-digit month-day and hour-minute in the reader's own clock.
     * @param iso - upstream `resetsAt`.
     * @returns `MM-DD HH:mm`, or an empty string when unusable.
     */
    function formatReset(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /**
     * Seconds left until a window rolls over.
     * @param iso - upstream `resetsAt`.
     * @param now - current epoch milliseconds.
     * @returns seconds (possibly <= 0), or null when the timestamp is unusable.
     */
    function remainingSeconds(iso, now) {
      if (typeof iso !== 'string' || iso === '') return null;
      const target = new Date(iso).getTime();
      if (Number.isNaN(target)) return null;
      return Math.floor((target - now) / 1000);
    }

    /**
     * Spoken phrasing for the tooltip: `距刷新 2小时 13分`.
     * @param iso - upstream `resetsAt`.
     * @param t - translate function.
     * @param now - current epoch milliseconds.
     * @returns the sentence, or an empty string when there is nothing to say.
     */
    function describeRemaining(iso, t, now) {
      const total = remainingSeconds(iso, now);
      if (total === null) return '';
      if (total <= 0) return t('usage.refreshing');
      const prefix = t('usage.refreshIn');
      if (total < 60) return `${prefix} ${total}${t('usage.secondUnit')}`;
      const minutes = Math.floor(total / 60);
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      if (hours === 0) return `${prefix} ${rest}${t('usage.minuteUnit')}`;
      return `${prefix} ${hours}${t('usage.hourUnit')} ${String(rest).padStart(2, '0')}${t('usage.minuteUnit')}`;
    }

    /**
     * Compact phrasing for the row's trailing slot: `2h13m`, `45m`, `42s`.
     * @param iso - upstream `resetsAt`.
     * @param t - translate function.
     * @param now - current epoch milliseconds.
     * @returns the compact label, or an empty string when unusable.
     */
    function formatRemaining(iso, t, now) {
      const total = remainingSeconds(iso, now);
      if (total === null) return '';
      if (total <= 0) return t('usage.refreshing');
      if (total < 60) return `${total}${t('usage.secondUnit')}`;
      const minutes = Math.floor(total / 60);
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      if (hours === 0) return `${rest}${t('usage.minuteUnit')}`;
      return `${hours}${t('usage.hourShort')}${String(rest).padStart(2, '0')}${t('usage.minuteUnit')}`;
    }

    /**
     * Live countdown for the short window's reset, shown after the card title so
     * the reset does not have to be hovered out of a tooltip. Ticking is local to
     * this node, so the rest of the card does not re-render every second.
     * @param props - translate and the upstream `resetsAt`.
     */
    function ResetCountdown(props) {
      const { t, resetAt } = props;
      const [now, setNow] = useState(() => Date.now());
      const live = typeof resetAt === 'string' && resetAt !== '';

      useEffect(() => {
        if (!live) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
      }, [live, resetAt]);

      const compact = formatRemaining(resetAt, t, now);
      if (compact === '') return null;
      return h('span', { style: S.countdown, title: describeRemaining(resetAt, t, now) }, compact);
    }

    /**
     * Fill color for one window: the accent while healthy, then warning, then error.
     * @param percent - share used, 0-100.
     * @returns a theme token reference.
     */
    function fillColor(percent) {
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary)';
      if (percent >= 70) return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-brand-primary)';
    }

    /**
     * One usage row: label, meter, and share used.
     * @param props - translate, label, percent, resetAt, limited.
     */
    function UsageRow(props) {
      const { t, label, percent, resetAt, limited } = props;
      const tone = limited ? 'var(--dsw-alias-state-error-primary)' : fillColor(percent);
      const reset = formatReset(resetAt);
      const title = reset === '' ? `${label} ${Math.round(percent)}%` : `${label} ${Math.round(percent)}% · ${t('usage.reset')} ${reset}`;

      return h(
        'div',
        { style: S.row, title },
        h('span', { style: S.rowLabel }, label),
        h(
          'div',
          {
            role: 'meter',
            'aria-label': label,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round(percent),
            style: S.track,
          },
          h('span', { style: { ...S.fill, width: `${Math.max(percent, 2)}%`, background: tone } }),
        ),
        h('span', { style: { ...S.rowValue, color: percent >= 90 || limited ? tone : undefined } }, `${Math.round(percent)}%`),
      );
    }

    /**
     * Refresh affordance in the card header.
     * @param props - translate and click handler.
     */
    function RefreshButton(props) {
      return h(
        'button',
        {
          type: 'button',
          title: props.t('usage.refresh'),
          'aria-label': props.t('usage.refresh'),
          onClick: props.onClick,
          style: S.refresh,
          onMouseEnter: (event) => {
            event.currentTarget.style.color = 'var(--dsw-alias-label-primary)';
            event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)';
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.color = 'var(--dsw-alias-label-secondary)';
            event.currentTarget.style.background = 'transparent';
          },
        },
        h(
          'svg',
          { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V5.2h-2.7',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      );
    }

    /**
     * The sidebar-foot card.
     * @param props - slot props (`wide`) plus the bound translate function.
     */
    function UsageCard(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      const wide = props.wide !== false;
      const [state, setState] = useState({ status: 'loading', data: null });
      const [nonce, setNonce] = useState(0);
      const lastFetchRef = useRef(0);

      useEffect(() => {
        let cancelled = false;
        let timer = null;

        const schedule = (delay) => {
          if (!cancelled) timer = setTimeout(tick, delay);
        };

        const tick = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            schedule(RETRY_MS);
            return;
          }
          lastFetchRef.current = Date.now();
          try {
            const response = await fetch(ENDPOINT, {
              method: 'GET',
              headers: { accept: 'application/json' },
              cache: 'no-store',
              credentials: 'same-origin',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (cancelled) return;
            setState({ status: 'ready', data });
            const poll = Math.max(MIN_POLL_SEC, Number(data?.pollIntervalSec) || 60);
            schedule(poll * 1000);
          } catch {
            if (cancelled) return;
            setState((previous) => ({ status: previous.status === 'ready' ? 'ready' : 'error', data: previous.data }));
            schedule(RETRY_MS);
          }
        };

        tick();
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [nonce]);

      // Wake up as soon as the window is visible again instead of waiting out
      // the remaining poll interval; the gap guard keeps focus churn cheap.
      useEffect(() => {
        const wake = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          if (Date.now() - lastFetchRef.current < WAKE_GAP_MS) return;
          setNonce((value) => value + 1);
        };
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('focus', wake);
        return () => {
          document.removeEventListener('visibilitychange', wake);
          window.removeEventListener('focus', wake);
        };
      }, []);

      // The Host pushes one event when a turn settles, which is exactly when
      // the subscription numbers can have moved.
      useEffect(() => {
        if (typeof EventSource !== 'function') return undefined;
        const source = new EventSource(STREAM);
        const wake = () => {
          if (Date.now() - lastFetchRef.current < WAKE_GAP_MS) return;
          setNonce((value) => value + 1);
        };
        source.addEventListener('usage', wake);
        return () => source.close();
      }, []);

      // The rail is an icon column: a three-row card cannot hold its geometry.
      if (!wide) return null;

      const data = state.data;
      const windows = Array.isArray(data?.windows) ? data.windows : [];

      if (state.status === 'loading') return null;

      if (data === null || data.ok !== true) {
        if (data && data.reason === 'missing-credential') return null;
        return h(
          'div',
          { style: S.card, role: 'group', 'aria-label': t('usage.title') },
          h(
            'div',
            { style: S.header },
            h(
              'span',
              { style: S.brand },
              h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-idle-primary)' } }),
              'OpenCode',
            ),
            h(RefreshButton, { t, onClick: () => setNonce((value) => value + 1) }),
          ),
          h('div', { style: S.unavailable }, t('usage.unavailable')),
        );
      }

      if (windows.length === 0) return null;

      const limited = windows.some((window) => window.limited === true);
      const rolling = windows.find((window) => window.key === 'rolling');

      return h(
        'div',
        { style: S.card, role: 'group', 'aria-label': t('usage.title'), 'data-opencode-usage': '1' },
        h(
          'div',
          { style: S.header },
          h(
            'span',
            { style: S.brand },
            h('span', {
              style: {
                ...S.dot,
                background: limited ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
              },
            }),
            'OpenCode',
            rolling ? h(ResetCountdown, { t, resetAt: rolling.resetsAt }) : null,
          ),
          h(RefreshButton, { t, onClick: () => setNonce((value) => value + 1) }),
        ),
        windows.map((window) =>
          h(UsageRow, {
            key: window.key,
            t,
            label: t(`usage.${window.key}`),
            percent: Number(window.percent) || 0,
            resetAt: window.resetsAt,
            limited: window.limited === true,
          }),
        ),
      );
    }

    const S = {
      card: {
        boxSizing: 'border-box',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        margin: '0 0 6px',
        padding: '8px 10px 9px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: 1.35,
        fontVariantNumeric: 'tabular-nums',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px',
        minHeight: '16px',
      },
      brand: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
        fontSize: '11px',
        letterSpacing: '0.03em',
        whiteSpace: 'nowrap',
      },
      dot: {
        width: '5px',
        height: '5px',
        borderRadius: '50%',
        flex: '0 0 auto',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        minWidth: 0,
        overflow: 'hidden',
      },
      rowLabel: {
        flex: '0 0 40px',
        fontSize: '11px',
        opacity: 0.78,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      track: {
        position: 'relative',
        flex: '1 1 auto',
        height: '4px',
        minWidth: '24px',
        borderRadius: '999px',
        background: 'var(--dsw-alias-bg-layer-2)',
        boxShadow: 'inset 0 0 0 1px var(--dsw-alias-border-l1)',
        overflow: 'hidden',
      },
      fill: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        borderRadius: '999px',
        transition: 'width 320ms ease',
      },
      rowValue: {
        flex: '0 0 30px',
        fontSize: '11px',
        textAlign: 'right',
        color: 'var(--dsw-alias-label-primary)',
      },
      unavailable: {
        fontSize: '11px',
        opacity: 0.7,
      },
      countdown: {
        flex: '0 0 auto',
        fontSize: '10px',
        lineHeight: 1,
        fontWeight: 400,
        letterSpacing: 'normal',
        color: 'var(--dsw-alias-label-secondary)',
        opacity: 0.72,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },
      refresh: {
        all: 'unset',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
    };

    return {
      inject: ['slots'],
      apply(ctx) {
        let t = fallbackTranslate;
        try {
          ctx.locale.register(NS, 'zh', DICTS.zh);
          ctx.locale.register(NS, 'en', DICTS.en);
          t = ctx.locale.bind(NS);
        } catch {
          // Locale service absent or its API changed: keep the English fallback.
        }
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'opencode-usage', order: 10 },
            (slotProps) => h(UsageCard, { ...slotProps, t }),
          ),
        );
      },
    };
  },
});
