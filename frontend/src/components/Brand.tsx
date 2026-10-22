export const PRODUCT_NAME = 'TalentFlow 人才智能体'

export function Brand({ compact = false, label = '人才评估与面试协同' }: { compact?: boolean; label?: string }) {
  return (
    <div className={`brand${compact ? ' compact' : ''}`} aria-label={`TalentFlow · ${label}`}>
      <span className="brand-logo-wrap" aria-hidden="true">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
          <rect width="36" height="36" rx="10" fill="#197465" />
          <path d="M9 11h18M18 11v16M11 19h14" stroke="white" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </span>
      {!compact && <span className="brand-copy"><strong>{label}</strong></span>}
    </div>
  )
}

export function EnvironmentBadge() {
  return <span className="environment-badge" title="AI生成内容须由工作人员确认">AI辅助评估 · 人工确认</span>
}
