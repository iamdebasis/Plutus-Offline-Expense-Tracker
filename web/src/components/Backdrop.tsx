/** The faint grid from the wireframe, plus two soft glows. Purely decorative. */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'linear-gradient(rgb(255 255 255 / 0.035) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.035) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(ellipse 70% 55% at 50% 0%, black 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 55% at 50% 0%, black 30%, transparent 75%)',
        }}
      />
      <div className="absolute -top-48 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-indigo-500/[0.07] blur-[120px]" />
      <div className="absolute top-40 -right-40 h-[420px] w-[520px] rounded-full bg-indigo-500/[0.07] blur-[120px]" />
    </div>
  )
}
