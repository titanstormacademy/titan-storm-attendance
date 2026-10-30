import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { ActionIcon, Badge, Box, Button, FileButton, Grid, Group, Modal, NumberInput, Paper, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { IconCalendarPlus, IconCamera, IconCopy, IconDeviceFloppy, IconEdit, IconPlus, IconTrash, IconUserStar } from '@tabler/icons-react'
import { deleteCoach, getCoachPayroll, getPayrollCoaches, removeUploadedImage, saveCoach, saveCoachPayroll, uploadImage } from '../lib/api'
import { EmptyState, PageHeader, PageLoader, PersonAvatar, PhotoLightbox } from '../components/ui'
import { publicImageUrl } from '../lib/supabase'
import { useNavigationGuard } from '../contexts/useNavigationGuard'
import type { Branch, BootstrapData, Coach } from '../types/models'

interface PayrollDraft {
  clientId: string
  id?: number
  work_date: string
  coach_id: number | null
  branch_id: number | null
  hours: number
  hourly_rate: number
  petrol_day_rate: number
  custom_amount_1: number
  custom_amount_2: number
  remarks: string
}

const blankCoach: Partial<Coach> & { name: string } = { name: '', phone: '', coach_type: 'Head', hourly_rate: 0, petrol_day_rate: 0, status: 'Active', photo_path: null }

export function CoachesPage({ branchId, branches, data, onChanged }: { branchId: number; branches: Branch[]; data: BootstrapData; onChanged: () => Promise<unknown> }) {
  const [formOpened, formModal] = useDisclosure(false)
  const [form, setForm] = useState(blankCoach)
  const [formBaseline, setFormBaseline] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoView, setPhotoView] = useState<{ src: string | null; name: string } | null>(null)
  const [coaches, setCoaches] = useState<Coach[]>(data.coaches)
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [customLabel1, setCustomLabel1] = useState('Allowance 1')
  const [customLabel2, setCustomLabel2] = useState('Allowance 2')
  const [entries, setEntries] = useState<PayrollDraft[]>([])
  const [payrollDirty, setPayrollDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const submitLock = useRef(false)
  const formDirty = formOpened && (Boolean(photo) || JSON.stringify(form) !== formBaseline)
  const { confirmDiscard } = useNavigationGuard('coach-payroll', { dirty: formDirty || payrollDirty, pending: loading || saving })

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([getCoachPayroll(month), getPayrollCoaches()]).then(([payroll, nextCoaches]) => {
      if (!active) return
      setCoaches(nextCoaches)
      setCustomLabel1(payroll.period?.custom_column_1_label || 'Allowance 1')
      setCustomLabel2(payroll.period?.custom_column_2_label || 'Allowance 2')
      setEntries(payroll.entries.map(toDraft))
      setPayrollDirty(false)
    }).catch((error) => notifications.show({ color: 'red', title: 'Payroll could not be loaded', message: errorMessage(error) })).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [month])

  const totals = useMemo(() => entries.reduce((result, entry) => ({ hours: result.hours + entry.hours, salary: result.salary + salary(entry), petrol: result.petrol + entry.petrol_day_rate, custom1: result.custom1 + entry.custom_amount_1, custom2: result.custom2 + entry.custom_amount_2, grand: result.grand + total(entry) }), { hours: 0, salary: 0, petrol: 0, custom1: 0, custom2: 0, grand: 0 }), [entries])
  const coachTotals = useMemo(() => coaches.map((coach) => {
    const rows = entries.filter((entry) => entry.coach_id === coach.id)
    return { coach, count: rows.length, hours: rows.reduce((sum, entry) => sum + entry.hours, 0), total: rows.reduce((sum, entry) => sum + total(entry), 0) }
  }).filter((item) => item.count).sort((a, b) => b.total - a.total), [coaches, entries])
  const coachOptions = coaches.map((coach) => ({ value: String(coach.id), label: `${coach.name}${coach.status === 'Inactive' ? ' · Inactive' : ''}` }))
  const branchOptions = branches.map((branch) => ({ value: String(branch.id), label: branch.name }))

  function editCoach(item?: Coach) {
    const next = item ? { ...item } : { ...blankCoach, branch_id: branchId }
    setForm(next)
    setFormBaseline(JSON.stringify(next))
    setPhoto(null)
    formModal.open()
  }

  function closeForm() {
    if (confirmDiscard({ dirty: formDirty, pending: saving })) formModal.close()
  }

  async function submitCoach() {
    if (!form.name.trim() || submitLock.current) return
    submitLock.current = true
    setSaving(true)
    try {
      const coachBranchId = form.branch_id || branchId
      let saved = await saveCoach(coachBranchId, form)
      let photoError: unknown = null
      if (photo) {
        const oldPhotoPath = saved.photo_path
        let path: string | null = null
        try {
          path = await uploadImage('coach-photos', saved.branch_id, photo, saved.id)
          saved = await saveCoach(saved.branch_id, { id: saved.id, name: saved.name, photo_path: path })
          if (oldPhotoPath && oldPhotoPath !== path) await removeUploadedImage('coach-photos', oldPhotoPath).catch(() => undefined)
        } catch (error) {
          if (path) await removeUploadedImage('coach-photos', path).catch(() => undefined)
          photoError = error
        }
      }
      setCoaches(await getPayrollCoaches())
      setPhoto(null)
      setFormBaseline(JSON.stringify(saved))
      formModal.close()
      try { await onChanged() } catch (error) { notifications.show({ color: 'orange', title: 'Coach saved, refresh failed', message: errorMessage(error) }) }
      notifications.show(photoError ? { color: 'orange', title: 'Coach saved without photo', message: errorMessage(photoError) } : { color: 'green', message: 'Coach saved' })
    } catch (error) {
      notifications.show({ color: 'red', message: errorMessage(error) })
    } finally {
      submitLock.current = false
      setSaving(false)
    }
  }

  async function removeCoach(item: Coach) {
    if (!window.confirm(`Delete ${item.name}? Deactivate the coach instead if they have historical records.`)) return
    try {
      await deleteCoach(item.branch_id, item.id)
      if (item.photo_path) await removeUploadedImage('coach-photos', item.photo_path).catch(() => undefined)
      setCoaches(await getPayrollCoaches())
      await onChanged()
    } catch (error) {
      notifications.show({ color: 'red', title: 'Coach cannot be deleted', message: `${errorMessage(error)} Deactivate the coach to preserve linked records.` })
    }
  }

  function changeMonth(value: string) {
    if (!value || value === month || !confirmDiscard({ dirty: payrollDirty, pending: saving })) return
    setMonth(value)
  }

  function addEntry(source?: PayrollDraft) {
    const coach = source?.coach_id ? coaches.find((item) => item.id === source.coach_id) : undefined
    setEntries((current) => [...current, { clientId: crypto.randomUUID(), work_date: source?.work_date || '', coach_id: source?.coach_id || null, branch_id: source?.branch_id || coach?.branch_id || branchId, hours: source?.hours || 0, hourly_rate: source?.hourly_rate ?? coach?.hourly_rate ?? 0, petrol_day_rate: source?.petrol_day_rate ?? coach?.petrol_day_rate ?? 0, custom_amount_1: source?.custom_amount_1 || 0, custom_amount_2: source?.custom_amount_2 || 0, remarks: source?.remarks || '' }])
    setPayrollDirty(true)
  }

  function updateEntry<K extends keyof PayrollDraft>(clientId: string, field: K, value: PayrollDraft[K]) {
    setEntries((current) => current.map((entry) => entry.clientId === clientId ? { ...entry, [field]: value } : entry))
    setPayrollDirty(true)
  }

  function selectCoach(entry: PayrollDraft, value: string | null) {
    const coach = coaches.find((item) => item.id === Number(value))
    setEntries((current) => current.map((item) => item.clientId === entry.clientId ? { ...item, coach_id: coach?.id || null, branch_id: coach?.branch_id || item.branch_id, hourly_rate: coach?.hourly_rate || 0, petrol_day_rate: coach?.petrol_day_rate || 0 } : item))
    setPayrollDirty(true)
  }

  function removeEntry(entry: PayrollDraft) {
    if (entry.id && !window.confirm('Delete this saved payroll entry?')) return
    setEntries((current) => current.filter((item) => item.clientId !== entry.clientId))
    setPayrollDirty(true)
  }

  async function savePayroll() {
    if (submitLock.current) return
    if (!customLabel1.trim() || !customLabel2.trim()) { notifications.show({ color: 'red', message: 'Both allowance headers are required' }); return }
    if (entries.some((entry) => !entry.work_date || !entry.work_date.startsWith(month) || !entry.coach_id || !entry.branch_id)) { notifications.show({ color: 'red', message: 'Every row needs a date in this month, a coach, and a branch' }); return }
    submitLock.current = true
    setSaving(true)
    try {
      await saveCoachPayroll({ month, customColumn1Label: customLabel1, customColumn2Label: customLabel2, entries: entries.map(({ clientId: _clientId, ...entry }) => ({ ...entry, coach_id: entry.coach_id!, branch_id: entry.branch_id! })) })
      const payroll = await getCoachPayroll(month)
      setEntries(payroll.entries.map(toDraft))
      setPayrollDirty(false)
      notifications.show({ color: 'green', message: `${dayjs(`${month}-01`).format('MMMM YYYY')} payroll saved` })
    } catch (error) {
      notifications.show({ color: 'red', title: 'Payroll was not saved', message: errorMessage(error) })
    } finally {
      submitLock.current = false
      setSaving(false)
    }
  }

  return <>
    <PageHeader title="Coach payroll" description="Add only the dates worked, adjust rates when needed, and review every coach in one monthly ledger" action={<Button leftSection={<IconPlus size={17} />} onClick={() => editCoach()}>Add coach</Button>} />
    <Paper className="payroll-command-bar" p={{ base: 'md', sm: 'lg' }} radius="lg" withBorder><Group justify="space-between" align="end" gap="md"><Group align="end" gap="sm"><TextInput type="month" label="Payroll month" value={month} onChange={(event) => changeMonth(event.currentTarget.value)} w={190} /><Button variant="light" leftSection={<IconCalendarPlus size={17} />} onClick={() => addEntry()}>Add work entry</Button></Group><Group gap="sm">{payrollDirty && <Badge color="orange" variant="light">Unsaved changes</Badge>}<Button leftSection={<IconDeviceFloppy size={17} />} onClick={savePayroll} loading={saving} disabled={!payrollDirty}>Save payroll</Button></Group></Group></Paper>
    <Box className="payroll-total-band" my="lg"><Box><Text size="xs">Month total</Text><Text className="payroll-grand-total">RM {money(totals.grand)}</Text></Box><Group className="payroll-total-breakdown" gap="xl"><TotalDatum label="Hours" value={number(totals.hours)} /><TotalDatum label="Salary" value={`RM ${money(totals.salary)}`} /><TotalDatum label="Petrol" value={`RM ${money(totals.petrol)}`} /><TotalDatum label={customLabel1 || 'Allowance 1'} value={`RM ${money(totals.custom1)}`} /><TotalDatum label={customLabel2 || 'Allowance 2'} value={`RM ${money(totals.custom2)}`} /></Group></Box>
    <Paper p={{ base: 'md', sm: 'lg' }} radius="lg" withBorder><Group justify="space-between" align="flex-start" mb="lg"><Box><Title order={3}>{dayjs(`${month}-01`).format('MMMM YYYY')} work ledger</Title><Text size="sm" c="dimmed" mt={3}>Dates are never generated automatically. Add one row for each day a coach worked.</Text></Box><Group gap="xs"><TextInput label="Custom column 1" value={customLabel1} maxLength={60} onChange={(event) => { setCustomLabel1(event.currentTarget.value); setPayrollDirty(true) }} /><TextInput label="Custom column 2" value={customLabel2} maxLength={60} onChange={(event) => { setCustomLabel2(event.currentTarget.value); setPayrollDirty(true) }} /></Group></Group>
      {loading ? <PageLoader label="Loading payroll…" /> : entries.length ? <><Box visibleFrom="md"><Table.ScrollContainer minWidth={1420}><Table className="payroll-table" verticalSpacing="xs"><Table.Thead><Table.Tr><Table.Th>Date</Table.Th><Table.Th>Coach</Table.Th><Table.Th>Branch</Table.Th><Table.Th>Hours</Table.Th><Table.Th>Salary/hour</Table.Th><Table.Th>Salary</Table.Th><Table.Th>Petrol/day</Table.Th><Table.Th>{customLabel1 || 'Allowance 1'}</Table.Th><Table.Th>{customLabel2 || 'Allowance 2'}</Table.Th><Table.Th>Total</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>{entries.map((entry) => <PayrollRow key={entry.clientId} entry={entry} month={month} coachOptions={coachOptions} branchOptions={branchOptions} onCoach={(value) => selectCoach(entry, value)} onChange={updateEntry} onDuplicate={() => addEntry(entry)} onDelete={() => removeEntry(entry)} />)}</Table.Tbody><Table.Tfoot><Table.Tr><Table.Th colSpan={3}>Monthly totals</Table.Th><Table.Th>{number(totals.hours)}</Table.Th><Table.Th /><Table.Th>RM {money(totals.salary)}</Table.Th><Table.Th>RM {money(totals.petrol)}</Table.Th><Table.Th>RM {money(totals.custom1)}</Table.Th><Table.Th>RM {money(totals.custom2)}</Table.Th><Table.Th>RM {money(totals.grand)}</Table.Th><Table.Th /></Table.Tr></Table.Tfoot></Table></Table.ScrollContainer></Box><Stack hiddenFrom="md" gap="sm">{entries.map((entry) => <PayrollCard key={entry.clientId} entry={entry} month={month} labels={[customLabel1 || 'Allowance 1', customLabel2 || 'Allowance 2']} coachOptions={coachOptions} branchOptions={branchOptions} onCoach={(value) => selectCoach(entry, value)} onChange={updateEntry} onDuplicate={() => addEntry(entry)} onDelete={() => removeEntry(entry)} />)}</Stack></> : <EmptyState title="No work entries this month" message="Add the first date a coach worked. Empty dates stay out of the ledger." icon={IconCalendarPlus} />}
    </Paper>
    {coachTotals.length > 0 && <Box mt="xl"><Group justify="space-between" mb="sm"><Title order={3}>Coach totals</Title><Text size="sm" c="dimmed">Calculated from this month’s ledger</Text></Group><div className="coach-total-list">{coachTotals.map(({ coach, count, hours, total: coachTotal }) => <div className="coach-total-row" key={coach.id}><PersonAvatar name={coach.name} src={publicImageUrl('coach-photos', coach.photo_path)} size={42} /><Box flex={1}><Text fw={750}>{coach.name}</Text><Text size="xs" c="dimmed">{count} work {count === 1 ? 'entry' : 'entries'} · {number(hours)} hours</Text></Box><Text fw={850}>RM {money(coachTotal)}</Text></div>)}</div></Box>}
    <Box mt={42}><Group justify="space-between" mb="md"><Box><Title order={3}>Coach profiles</Title><Text size="sm" c="dimmed" mt={3}>Default rates are copied into new payroll rows and can be overridden there.</Text></Box><Badge variant="light" color="gray">{coaches.length} coaches</Badge></Group>{coaches.length ? <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }}>{coaches.map((item) => <Paper key={item.id} p="md" radius="lg" withBorder><Group align="flex-start" wrap="nowrap"><PersonAvatar name={item.name} src={publicImageUrl('coach-photos', item.photo_path)} size={54} onClick={() => setPhotoView({ src: publicImageUrl('coach-photos', item.photo_path), name: item.name })} /><Stack gap={4} flex={1} style={{ minWidth: 0 }}><Group justify="space-between" wrap="nowrap"><Text fw={800} truncate>{item.name}</Text><Group gap={2} wrap="nowrap"><ActionIcon aria-label={`Edit ${item.name}`} size={38} variant="subtle" color="gray" onClick={() => editCoach(item)}><IconEdit size={16} /></ActionIcon><ActionIcon aria-label={`Delete ${item.name}`} size={38} variant="subtle" color="red" onClick={() => removeCoach(item)}><IconTrash size={16} /></ActionIcon></Group></Group><Text size="xs" c="dimmed">{branches.find((branch) => branch.id === item.branch_id)?.name || 'Unknown branch'} · {item.coach_type}</Text><Group gap="xs"><Badge variant="light">RM {money(item.hourly_rate)}/h</Badge><Badge variant="light" color="teal">RM {money(item.petrol_day_rate)}/day</Badge><Badge variant="outline" color={item.status === 'Active' ? 'green' : 'gray'}>{item.status}</Badge></Group></Stack></Group></Paper>)}</SimpleGrid> : <EmptyState title="No coaches yet" message="Add a coach and set their default salary and petrol rates." icon={IconUserStar} />}</Box>
    <Modal opened={formOpened} onClose={closeForm} title={form.id ? `Edit ${form.name}` : 'Add coach'} centered size="lg"><Stack><Group justify="center"><Box className="profile-photo-editor"><PersonAvatar name={form.name || 'New coach'} src={publicImageUrl('coach-photos', form.photo_path || null)} size={92} onClick={() => setPhotoView({ src: publicImageUrl('coach-photos', form.photo_path || null), name: form.name || 'Coach photo' })} /><FileButton onChange={setPhoto} accept="image/png,image/jpeg,image/webp">{(props) => <ActionIcon {...props} className="profile-camera-button" aria-label="Choose coach photo" color="orange" size={32} radius="xl"><IconCamera size={16} /></ActionIcon>}</FileButton></Box></Group>{photo && <Text size="xs" c="orange" ta="center">New photo selected · save to upload</Text>}<Grid><Grid.Col span={{ base: 12, sm: 7 }}><TextInput label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></Grid.Col><Grid.Col span={{ base: 12, sm: 5 }}><TextInput label="Phone" value={form.phone || ''} onChange={(event) => setForm({ ...form, phone: event.currentTarget.value })} /></Grid.Col>{!form.id && <Grid.Col span={{ base: 12, sm: 4 }}><Select label="Home branch" value={form.branch_id ? String(form.branch_id) : String(branchId)} onChange={(value) => setForm({ ...form, branch_id: value ? Number(value) : branchId })} data={branchOptions} allowDeselect={false} /></Grid.Col>}<Grid.Col span={{ base: 6, sm: 4 }}><Select label="Type" value={form.coach_type} onChange={(value) => setForm({ ...form, coach_type: value as Coach['coach_type'] })} data={[{ value: 'Head', label: 'Head coach' }, { value: 'Assistant', label: 'Assistant coach' }]} /></Grid.Col><Grid.Col span={{ base: 6, sm: 4 }}><Select label="Status" value={form.status} onChange={(value) => setForm({ ...form, status: value as Coach['status'] })} data={['Active', 'Inactive']} /></Grid.Col><Grid.Col span={{ base: 12, sm: 6 }}><NumberInput label="Default salary/hour (RM)" value={form.hourly_rate || 0} onChange={(value) => setForm({ ...form, hourly_rate: numeric(value) })} min={0} decimalScale={2} /></Grid.Col><Grid.Col span={{ base: 12, sm: 6 }}><NumberInput label="Default petrol/day (RM)" value={form.petrol_day_rate || 0} onChange={(value) => setForm({ ...form, petrol_day_rate: numeric(value) })} min={0} decimalScale={2} /></Grid.Col></Grid><Group justify="flex-end"><Button variant="default" disabled={saving} onClick={closeForm}>Cancel</Button><Button onClick={submitCoach} loading={saving}>Save coach</Button></Group></Stack></Modal>
    <PhotoLightbox src={photoView?.src || null} name={photoView?.name || 'Coach photo'} opened={Boolean(photoView)} onClose={() => setPhotoView(null)} />
  </>
}

function PayrollRow({ entry, month, coachOptions, branchOptions, onCoach, onChange, onDuplicate, onDelete }: PayrollEditorProps) {
  return <Table.Tr><Table.Td><TextInput aria-label="Work date" type="date" value={entry.work_date} min={`${month}-01`} max={dayjs(`${month}-01`).endOf('month').format('YYYY-MM-DD')} onChange={(event) => onChange(entry.clientId, 'work_date', event.currentTarget.value)} w={145} /></Table.Td><Table.Td><Select aria-label="Coach" searchable value={entry.coach_id ? String(entry.coach_id) : null} onChange={onCoach} data={coachOptions} w={180} /></Table.Td><Table.Td><Select aria-label="Branch" value={entry.branch_id ? String(entry.branch_id) : null} onChange={(value) => onChange(entry.clientId, 'branch_id', value ? Number(value) : null)} data={branchOptions} w={160} /></Table.Td><Table.Td><MoneyInput label="Hours" value={entry.hours} onChange={(value) => onChange(entry.clientId, 'hours', value)} width={82} /></Table.Td><Table.Td><MoneyInput label="Salary per hour" value={entry.hourly_rate} onChange={(value) => onChange(entry.clientId, 'hourly_rate', value)} /></Table.Td><Table.Td><Text fw={700} className="payroll-calculated-cell">RM {money(salary(entry))}</Text></Table.Td><Table.Td><MoneyInput label="Petrol per day" value={entry.petrol_day_rate} onChange={(value) => onChange(entry.clientId, 'petrol_day_rate', value)} /></Table.Td><Table.Td><MoneyInput label="First custom allowance" value={entry.custom_amount_1} onChange={(value) => onChange(entry.clientId, 'custom_amount_1', value)} /></Table.Td><Table.Td><MoneyInput label="Second custom allowance" value={entry.custom_amount_2} onChange={(value) => onChange(entry.clientId, 'custom_amount_2', value)} /></Table.Td><Table.Td><Text fw={850} className="payroll-row-total">RM {money(total(entry))}</Text></Table.Td><Table.Td><Group gap={2} wrap="nowrap"><ActionIcon aria-label="Duplicate payroll row" variant="subtle" color="gray" onClick={onDuplicate}><IconCopy size={16} /></ActionIcon><ActionIcon aria-label="Delete payroll row" variant="subtle" color="red" onClick={onDelete}><IconTrash size={16} /></ActionIcon></Group></Table.Td></Table.Tr>
}

interface PayrollEditorProps { entry: PayrollDraft; month: string; coachOptions: Array<{ value: string; label: string }>; branchOptions: Array<{ value: string; label: string }>; onCoach: (value: string | null) => void; onChange: <K extends keyof PayrollDraft>(clientId: string, field: K, value: PayrollDraft[K]) => void; onDuplicate: () => void; onDelete: () => void }

function PayrollCard({ entry, month, labels, coachOptions, branchOptions, onCoach, onChange, onDuplicate, onDelete }: PayrollEditorProps & { labels: [string, string] }) {
  return <Paper className="payroll-mobile-card" p="md" radius="md" withBorder><Group justify="space-between" mb="sm"><Text fw={850}>RM {money(total(entry))}</Text><Group gap={2}><ActionIcon aria-label="Duplicate payroll row" variant="subtle" color="gray" onClick={onDuplicate}><IconCopy size={16} /></ActionIcon><ActionIcon aria-label="Delete payroll row" variant="subtle" color="red" onClick={onDelete}><IconTrash size={16} /></ActionIcon></Group></Group><Grid gutter="xs"><Grid.Col span={6}><TextInput label="Date" type="date" value={entry.work_date} min={`${month}-01`} max={dayjs(`${month}-01`).endOf('month').format('YYYY-MM-DD')} onChange={(event) => onChange(entry.clientId, 'work_date', event.currentTarget.value)} /></Grid.Col><Grid.Col span={6}><NumberInput label="Hours" value={entry.hours} min={0} decimalScale={2} onChange={(value) => onChange(entry.clientId, 'hours', numeric(value))} /></Grid.Col><Grid.Col span={12}><Select label="Coach" searchable value={entry.coach_id ? String(entry.coach_id) : null} onChange={onCoach} data={coachOptions} /></Grid.Col><Grid.Col span={12}><Select label="Branch" value={entry.branch_id ? String(entry.branch_id) : null} onChange={(value) => onChange(entry.clientId, 'branch_id', value ? Number(value) : null)} data={branchOptions} /></Grid.Col><Grid.Col span={6}><NumberInput label="Salary/hour" prefix="RM " value={entry.hourly_rate} min={0} decimalScale={2} onChange={(value) => onChange(entry.clientId, 'hourly_rate', numeric(value))} /></Grid.Col><Grid.Col span={6}><NumberInput label="Petrol/day" prefix="RM " value={entry.petrol_day_rate} min={0} decimalScale={2} onChange={(value) => onChange(entry.clientId, 'petrol_day_rate', numeric(value))} /></Grid.Col><Grid.Col span={6}><NumberInput label={labels[0]} prefix="RM " value={entry.custom_amount_1} min={0} decimalScale={2} onChange={(value) => onChange(entry.clientId, 'custom_amount_1', numeric(value))} /></Grid.Col><Grid.Col span={6}><NumberInput label={labels[1]} prefix="RM " value={entry.custom_amount_2} min={0} decimalScale={2} onChange={(value) => onChange(entry.clientId, 'custom_amount_2', numeric(value))} /></Grid.Col></Grid><Group justify="space-between" mt="md" pt="sm" className="payroll-mobile-calculation"><Text size="sm" c="dimmed">Salary: RM {money(salary(entry))}</Text><Text fw={800}>Total: RM {money(total(entry))}</Text></Group></Paper>
}

function MoneyInput({ label, value, onChange, width = 105 }: { label: string; value: number; onChange: (value: number) => void; width?: number }) { return <NumberInput aria-label={label} prefix={label === 'Hours' ? undefined : 'RM '} value={value} min={0} decimalScale={2} hideControls onChange={(next) => onChange(numeric(next))} w={width} /> }
function TotalDatum({ label, value }: { label: string; value: string }) { return <Box><Text size="xs">{label}</Text><Text fw={800}>{value}</Text></Box> }
function toDraft(entry: { id: number; work_date: string; coach_id: number; branch_id: number; hours: number; hourly_rate: number; petrol_day_rate: number; custom_amount_1: number; custom_amount_2: number; remarks: string }): PayrollDraft { return { clientId: `saved-${entry.id}`, id: entry.id, work_date: entry.work_date, coach_id: entry.coach_id, branch_id: entry.branch_id, hours: Number(entry.hours), hourly_rate: Number(entry.hourly_rate), petrol_day_rate: Number(entry.petrol_day_rate), custom_amount_1: Number(entry.custom_amount_1), custom_amount_2: Number(entry.custom_amount_2), remarks: entry.remarks } }
function salary(entry: PayrollDraft) { return entry.hours * entry.hourly_rate }
function total(entry: PayrollDraft) { return salary(entry) + entry.petrol_day_rate + entry.custom_amount_1 + entry.custom_amount_2 }
function numeric(value: string | number) { return value === '' ? 0 : Number(value) }
function money(value: number) { return Number(value).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function number(value: number) { return Number(value).toLocaleString('en-MY', { maximumFractionDigits: 2 }) }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong' }
