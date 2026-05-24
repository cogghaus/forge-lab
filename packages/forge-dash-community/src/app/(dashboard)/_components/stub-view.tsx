export function StubView({ title, phase }: { title: string; phase: string }) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <h1 className="font-mono text-[18px] font-bold">{title}</h1>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.08em] px-2 py-0.5 rounded"
          style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(245,240,235,0.4)' }}
        >
          {phase}
        </span>
      </div>
      <div
        className="rounded-[10px] p-8 flex flex-col items-center gap-3 text-center"
        style={{ background: '#1A1A1F', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <p className="text-[13px]" style={{ color: 'rgba(245,240,235,0.4)' }}>
          {title} view coming in {phase}.
        </p>
      </div>
    </div>
  );
}
