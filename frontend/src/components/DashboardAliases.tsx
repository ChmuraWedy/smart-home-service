import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { MSG, t } from '../i18n';
import { IconGlyph } from './ui/icon';

export function DashboardAliases({ aliases }: { aliases: string[] }) {
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [{ visibleCount, overflow }, setLayout] = useState({ visibleCount: aliases.length, overflow: false });
  const tooltipId = useId();

  useLayoutEffect(() => {
    const container = row.current!, ruler = measure.current!;
    function update() {
      const available = container.getBoundingClientRect().width;
      if (!available) return;
      const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
      const moreWidth = ruler.lastElementChild!.getBoundingClientRect().width;
      const widths = Array.from(ruler.querySelectorAll('.alias-tag'), tag => tag.getBoundingClientRect().width);
      const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
      const updateLayout = (visibleCount: number, overflow: boolean) => setLayout(current =>
        current.visibleCount === visibleCount && current.overflow === overflow ? current : { visibleCount, overflow });
      if (total <= available) { updateLayout(aliases.length, false); return; }

      const limit = available - moreWidth - gap;
      let count = 0, used = 0;
      for (const width of widths) {
        used += width + (count ? gap : 0);
        if (used > limit) break;
        count++;
      }
      // Keep an abbreviated first alias if even one whole tag is too wide.
      updateLayout(Math.max(count, limit > 0 ? 1 : 0), true);
    }
    update();
    if (!window.ResizeObserver) {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(ruler);
    return () => observer.disconnect();
  }, [aliases]);

  const hiddenAliases = aliases.slice(visibleCount);
  const preview = (hiddenAliases.length ? hiddenAliases : aliases).join(', ');
  return <div className="dashboard-aliases" ref={row} role="group" aria-label={t(MSG.DEVICE_ALIASES)}>
    <div className="dashboard-alias-measure-box" aria-hidden="true">
      <div className="dashboard-alias-measure" ref={measure}>
        {aliases.map(alias => <span className="alias-tag" key={alias} data-alias={alias} />)}
        <span className="dashboard-alias-more-width" />
      </div>
    </div>
    <div className="dashboard-alias-visible">
      {aliases.slice(0, visibleCount).map(alias => <span className="alias-tag" title={alias} key={alias}>{alias}</span>)}
    </div>
    {overflow && <Popover className="dashboard-alias-overflow">
      {({ open }) => <>
        <PopoverButton type="button" className="secondary dashboard-alias-more" aria-label={t(MSG.SHOW_ALL_ALIASES)}
          aria-describedby={open ? undefined : tooltipId}><IconGlyph name="more" /></PopoverButton>
        {!open && <span className="dashboard-alias-tooltip" id={tooltipId} role="tooltip">{preview}</span>}
        <PopoverPanel anchor={{ to: 'bottom end', gap: 6, padding: 8 }} focus className="dashboard-alias-popup"
          role="dialog" aria-label={t(MSG.DEVICE_ALIASES)} onClick={event => event.stopPropagation()}>
          {({ close }) => <>
            <div className="dashboard-alias-popup-header">
              <strong>{t(MSG.DEVICE_ALIASES)}</strong>
              <button type="button" className="secondary compact" aria-label={t(MSG.CLOSE)} onClick={() => close()}><IconGlyph name="close" /></button>
            </div>
            <ul className="capability-aliases">
              {aliases.map(alias => <li className="alias-tag" key={alias}>{alias}</li>)}
            </ul>
          </>}
        </PopoverPanel>
      </>}
    </Popover>}
  </div>;
}
