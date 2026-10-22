import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Card, Collapse, Empty, Form, Input, Typography } from 'antd'
import './SensitiveRulesEditor.css'

export interface SensitiveRuleEntry {
  id: number
  reason: string
  keywords: SensitiveKeyword[]
}

interface SensitiveKeyword {
  id: number
  kind: 'keyword' | 'advanced'
  value: string
  originalPattern?: string
  originalValue?: string
}

let nextEntryId = 0
const newKeyword = (value = ''): SensitiveKeyword => ({ id: nextEntryId++, kind: 'keyword', value })

// Only decode patterns that are certainly literals under Python re.search.
// Unknown escapes, character classes, flags and other expressions stay read-only.
function decodeLiteralPattern(pattern: string): string | null {
  let literal = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === '\\') {
      const escaped = pattern[++index]
      if (escaped === undefined || /[a-zA-Z0-9]/.test(escaped)) return null
      literal += escaped
    } else {
      if ('.^$*+?{}[]|()'.includes(character)) return null
      literal += character
    }
  }
  return literal
}

function loadKeyword(pattern: string): SensitiveKeyword {
  const literal = decodeLiteralPattern(pattern)
  return {
    id: nextEntryId++, kind: literal === null ? 'advanced' : 'keyword',
    value: literal ?? pattern, originalPattern: pattern, originalValue: literal ?? pattern,
  }
}

function keywordPattern(keyword: SensitiveKeyword): string {
  if (keyword.originalPattern !== undefined && (keyword.kind === 'advanced' || keyword.value === keyword.originalValue)) return keyword.originalPattern
  // Equivalent literal escaping for the metacharacters Python's re.escape covers.
  return keyword.value.replace(/[.*+?^${}()|\[\]\\\-#&~\s]/g, '\\$&')
}

export function createSensitiveRuleEntries(rules: Record<string, string[]>): SensitiveRuleEntry[] {
  return Object.entries(rules).map(([reason, keywords]) => ({
    id: nextEntryId++, reason, keywords: keywords.map(loadKeyword),
  }))
}

export function serializeSensitiveRules(entries: SensitiveRuleEntry[]): Record<string, string[]> {
  if (!entries.length) throw new Error('请至少添加一个规则分类')
  const reasons = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const reason = entry.reason.trim()
    if (!reason) throw new Error(`请填写第 ${index + 1} 个分类的名称`)
    if (reasons.has(reason)) throw new Error(`分类名称“${reason}”重复，请修改后保存`)
    reasons.add(reason)
    if (!entry.keywords.length) throw new Error(`“${reason}”至少需要一个关键词`)
    const keywords = new Set<string>()
    for (const [keywordIndex, keyword] of entry.keywords.filter(item => item.kind === 'keyword').entries()) {
      const value = keyword.value.trim()
      if (!value) throw new Error(`请填写“${reason}”的第 ${keywordIndex + 1} 个关键词，或删除空白项`)
      if (keywords.has(value)) throw new Error(`“${reason}”中有重复关键词“${value}”，请删除重复项`)
      keywords.add(value)
    }
  }
  return Object.fromEntries(entries.map(entry => [entry.reason, entry.keywords.map(keywordPattern)]))
}

interface Props {
  value: SensitiveRuleEntry[]
  onChange: (entries: SensitiveRuleEntry[]) => void
  disabled?: boolean
}

export function SensitiveRulesEditor({ value, onChange, disabled = false }: Props) {
  const updateEntry = (id: number, change: Partial<SensitiveRuleEntry>) => onChange(value.map(entry => entry.id === id ? { ...entry, ...change } : entry))

  return <div className="sensitive-rules-editor">
    <Typography.Paragraph type="secondary">按拦截原因分类维护关键词。命中任一关键词时，系统会拦截相关内容并显示所属分类。每项填写一个关键词，标点也按输入的文字匹配；编辑完成后点击“保存规则”生效。</Typography.Paragraph>
    {!value.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未添加规则分类" />}
    {value.map((entry, index) => <Card key={entry.id} size="small" title={`分类 ${index + 1}`} extra={<Button danger type="text" icon={<DeleteOutlined />} disabled={disabled} aria-label={`删除第${index + 1}个分类`} onClick={() => onChange(value.filter(item => item.id !== entry.id))}>删除分类</Button>}>
      <Form.Item label="分类名称（拦截原因）" required>
        <Input aria-label={`第${index + 1}类规则名称`} placeholder="例如：婚育和家庭隐私" value={entry.reason} disabled={disabled} onChange={event => updateEntry(entry.id, { reason: event.target.value })} />
      </Form.Item>
      <Form.Item label="拦截关键词" required>
        <div className="sensitive-rule-keywords">
          {entry.keywords.filter(keyword => keyword.kind === 'keyword').map((keyword, keywordIndex) => <div className="sensitive-rule-keyword" key={keyword.id}>
            <Input aria-label={`第${index + 1}类第${keywordIndex + 1}个关键词`} placeholder="填写一个关键词" value={keyword.value} disabled={disabled} onChange={event => updateEntry(entry.id, { keywords: entry.keywords.map(item => item.id === keyword.id ? { ...item, value: event.target.value } : item) })} />
            <Button danger type="text" icon={<DeleteOutlined />} disabled={disabled} aria-label={`删除第${index + 1}类第${keywordIndex + 1}个关键词`} onClick={() => updateEntry(entry.id, { keywords: entry.keywords.filter(item => item.id !== keyword.id) })} />
          </div>)}
          <Button type="dashed" icon={<PlusOutlined />} disabled={disabled} aria-label={`为第${index + 1}类添加关键词`} onClick={() => updateEntry(entry.id, { keywords: [...entry.keywords, newKeyword()] })}>添加关键词</Button>
        </div>
      </Form.Item>
      {entry.keywords.some(keyword => keyword.kind === 'advanced') && <Collapse style={{ marginTop: 16 }} items={[{
        key: 'advanced', label: `已有高级匹配规则（${entry.keywords.filter(keyword => keyword.kind === 'advanced').length}）`, children: <>
          <Typography.Paragraph type="secondary">这些规则来自已有配置，将继续原样使用。如需调整，可删除后添加普通关键词。</Typography.Paragraph>
          <div className="sensitive-rule-keywords">{entry.keywords.filter(keyword => keyword.kind === 'advanced').map((keyword, keywordIndex) => <div className="sensitive-rule-keyword" key={keyword.id}>
            <Input.TextArea aria-label={`第${index + 1}类第${keywordIndex + 1}条已有高级规则`} value={keyword.value} readOnly autoSize />
            <Button danger type="text" icon={<DeleteOutlined />} disabled={disabled} aria-label={`删除第${index + 1}类第${keywordIndex + 1}条已有高级规则`} onClick={() => updateEntry(entry.id, { keywords: entry.keywords.filter(item => item.id !== keyword.id) })} />
          </div>)}</div>
        </>,
      }]} />}
    </Card>)}
    <Button type="dashed" block icon={<PlusOutlined />} disabled={disabled} onClick={() => onChange([...value, { id: nextEntryId++, reason: '', keywords: [newKeyword()] }])}>添加规则分类</Button>
  </div>
}
