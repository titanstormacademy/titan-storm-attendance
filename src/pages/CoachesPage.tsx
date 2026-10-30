import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { ActionIcon, Badge, Box, Button, Collapse, FileButton, Grid, Group, Modal, NumberInput, Paper, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { IconCalendarPlus, IconCamera, IconChevronDown, IconDeviceFloppy, IconEdit, IconPlus, IconTrash, IconUserStar } from '@tabler/icons-react'
import { deleteCoach, getCoachPayroll, getPayrollCoaches, removeUploadedImage, saveCoach, saveCoachPayroll, uploadImage } from '../lib/api'
import { EmptyState, PageHeader, PageLoader, PersonAvatar, PhotoLightbox } from '../components/ui'
import { publicImageUrl } from '../lib/supabase'
import { useNavigationGuard } from '../contexts/useNavigationGuard'
import type { Branch, BootstrapData, Coach, CoachPayrollRow } from '../types/models'

interface PayrollDraft {
  clientId: string
  id?: number
  coach_id: number | null
  branch_id: number | null
  hourly_rate: number
  petrol_day_rate: number
  custom_amount_1: number
  custom_amount_2: number
  hours: Record<string, number>
}

const blankCoach: Partial<Coach> & { name: string } = { name: '', phone: '', coach_type: 'Head', hourly_rate: 0, petrol_day_rate: 0, status: 'Active', photo_path: null }

export function CoachesPage({ branchId, branches, data, onChanged }: { branchId: number; branches: Branch[]; data: BootstrapData; onChanged: () => Promise<unknown> }) {
  const [formOpened, formModal] = useDisclosure(false)
  const [datesOpened, datesModal] = useDisclosure(false)
  const [form, setForm] = useState(blankCoach)
  const [formBaseline, setFormBaseline] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoView, setPhotoView] = useState<{ src: string | null; name: string } | null>(null)
  const [coaches, setCoaches] = useState<Coach[]>(data.coaches)
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [dates, setDates] = useState<string[]>([])
  const [dateDraft, setDateDraft] = useState('')
  const [customLabel1, setCustomLabel1] = useState('Allowance 1')
  const [customLabel2, setCustomLabel2] = useState('Allowance 2')
  const [rows, setRows] = useState<PayrollDraft[]>([])
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
      setDates(payroll.dates.map((item) => item.work_date))
      setCustomLabel1(payroll.period?.custom_column_1_label || 'Allowance 1')
      setCustomLabel2(payroll.period?.custom_column_2_label || 'Allowance 2')
      setRows(payroll.rows.map(toDraft))
      setDateDraft('')
      setPayrollDirty(false)
    }).catch((error) => notifications.show({ color: 'red', title: 'Payroll could not be loaded', message: errorMessage(error) })).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [month])

  const totals = useMemo(() => rows.reduce((result, row) => ({ hours: result.hours + rowHours(row), salary: result.salary + salary(row), petrol: result.petrol + petrol(row), custom1: result.custom1 + row.custom_amount_1, custom2: result.custom2 + row.custom_amount_2, grand: result.grand + total(row) }), { hours: 0, salary: 0, petrol: 0, custom1: 0, custom2: 0, grand: 0 }), [rows])
  const coachOptions = coaches.map((coach) => ({ value: String(coach.id), label: `${coach.name}${coach.status === 'Inactive' ? ' · Inactive' : ''}` }))
  const branchOptions = branches.map((branch) => ({ value: String(branch.id), label: branch.name }))

  function editCoach(item?: Coach) {
    const next = item ? { ...item } : { ...blankCoach, branch_id: branchId }
    setForm(next); setFormBaseline(JSON.stringify(next)); setPhoto(null); formModal.open()
  }

  function closeForm() { if (confirmDiscard({ dirty: formDirty, pending: saving })) formModal.close() }

  async function submitCoach() {
    if (!form.name.trim() || submitLock.current) return
    submitLock.current = true; setSaving(true)
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
      setCoaches(await getPayrollCoaches()); setPhoto(null); setFormBaseline(JSON.stringify(saved)); formModal.close()
      try { await onChanged() } catch (error) { notifications.show({ color: 'orange', title: 'Coach saved, refresh failed', message: errorMessage(error) }) }
      notifications.show(photoError ? { color: 'orange', title: 'Coach saved without photo', message: errorMessage(photoError) } : { color: 'green', message: 'Coach saved' })
    } catch (error) { notifications.show({ color: 'red', message: errorMessage(error) }) }
    finally { submitLock.current = false; setSaving(false) }
  }

  async function removeCoach(item: Coach) {
    if (!window.confirm(`Delete ${item.name}? Deactivate the coach instead if they have historical records.`)) return
    try {
      await deleteCoach(item.branch_id, item.id)
      if (item.photo_path) await removeUploadedImage('coach-photos', item.photo_path).catch(() => undefined)
      setCoaches(await getPayrollCoaches()); await onChanged()
    } catch (error) { notifications.show({ color: 'red', title: 'Coach cannot be deleted', message: `${errorMessage(error)} Deactivate the coach to preserve linked records.` }) }
  }

  function changeMonth(value: string) {
    if (!value || value === month || !confirmDiscard({ dirty: payrollDirty, pending: saving })) return
    setMonth(value)
  }

  function addDate() {
    if (!dateDraft || !dateDraft.startsWith(month)) { notifications.show({ color: 'red', message: 'Choose a date inside the selected payroll month' }); return }
    if (dates.includes(dateDraft)) { notifications.show({ color: 'orange', message: 'That date is already in the payroll table' }); return }
    setDates((current) => [...current, dateDraft].sort()); setDateDraft(''); setPayrollDirty(true)
  }

  function removeDate(date: string) {
    if (!window.confirm(`Remove ${dayjs(date).format('D MMM')} and all hours entered for it?`)) return
    setDates((current) => current.filter((item) => item !== date))
    setRows((current) => current.map((row) => { const hours = { ...row.hours }; delete hours[date]; return { ...row, hours } }))
    setPayrollDirty(true)
  }

  function addRow() {
    setRows((current) => [...current, { clientId: crypto.randomUUID(), coach_id: null, branch_id: branchId, hourly_rate: 0, petrol_day_rate: 0, custom_amount_1: 0, custom_amount_2: 0, hours: {} }])
    setPayrollDirty(true)
  }

  function updateRow<K extends keyof PayrollDraft>(clientId: string, field: K, value: PayrollDraft[K]) {
    setRows((current) => current.map((row) => row.clientId === clientId ? { ...row, [field]: value } : row)); setPayrollDirty(true)
  }

  function updateHours(row: PayrollDraft, date: string, hours: number) {
    updateRow(row.clientId, 'hours', { ...row.hours, [date]: hours })
  }

  function selectCoach(row: PayrollDraft, value: string | null) {
    const coach = coaches.find((item) => item.id === Number(value))
    setRows((current) => current.map((item) => item.clientId === row.clientId ? { ...item, coach_id: coach?.id || null, branch_id: coach?.branch_id || item.branch_id, hourly_rate: coach?.hourly_rate || 0, petrol_day_rate: coach?.petrol_day_rate || 0 } : item)); setPayrollDirty(true)
  }

  function removeRow(row: PayrollDraft) {
    if (row.id && !window.confirm('Delete this coach from the monthly payroll?')) return
    setRows((current) => current.filter((item) => item.clientId !== row.clientId)); setPayrollDirty(true)
  }

  async function savePayroll() {
    if (submitLock.current) return
    if (!customLabel1.trim() || !customLabel2.trim()) { notifications.show({ color: 'red', message: 'Both allowance headers are required' }); return }
    if (rows.some((row) => !row.coach_id || !row.branch_id)) { notifications.show({ color: 'red', message: 'Every payroll row needs a coach and branch' }); return }
    const keys = rows.map((row) => `${row.coach_id}:${row.branch_id}`)
    if (new Set(keys).size !== keys.length) { notifications.show({ color: 'red', message: 'A coach can only appear once for the same branch in a month' }); return }
    submitLock.current = true; setSaving(true)
    try {
      await saveCoachPayroll({ month, customColumn1Label: customLabel1, customColumn2Label: customLabel2, dates, rows: rows.map(({ clientId: _clientId, hours, ...row }) => ({ ...row, coach_id: row.coach_id!, branch_id: row.branch_id!, hours: dates.map((date) => ({ work_date: date, hours: hours[date] || 0 })) })) })
      const payroll = await getCoachPayroll(month)
      setDates(payroll.dates.map((item) => item.work_date)); setRows(payroll.rows.map(toDraft)); setPayrollDirty(false)
      notifications.show({ color: 'green', message: `${dayjs(`${month}-01`).format('MMMM YYYY')} payroll saved` })
    } catch (error) { notifications.show({ color: 'red', title: 'Payroll was not saved', message: errorMessage(error) }) }
    finally { submitLock.current = false; setSaving(false) }
  }

  return <>
    <PageHeader title="Coach payroll" description="One coach per row. Add the class dates you need, then enter each coach’s hours under those dates." action={<Button leftSection={<IconPlus size={17} />} onClick={() => editCoach()}>Add coach profile</Button>} />
    <Paper className="payroll-command-bar" p={{ base: 'md', sm: 'lg' }} radius="lg" withBorder><Group justify="space-between" align="end" gap="md"><Group align="end" gap="sm"><TextInput type="month" label="Payroll month" value={month} onChange={(event) => changeMonth(event.currentTarget.value)} w={190} /><Button variant="light" leftSection={<IconCalendarPlus size={17} />} onClick={datesModal.open}>Manage dates <Badge ml={6} size="sm" variant="filled" color="orange">{dates.length}</Badge></Button><Button variant="default" leftSection={<IconPlus size={17} />} onClick={addRow}>Add coach row</Button></Group><Group gap="sm">{payrollDirty && <Badge color="orange" variant="light">Unsaved changes</Badge>}<Button visibleFrom="md" leftSection={<IconDeviceFloppy size={17} />} onClick={savePayroll} loading={saving} disabled={!payrollDirty}>Save payroll</Button></Group></Group></Paper>
    <Box className="payroll-total-band" my="lg"><Box><Text size="xs">Month total</Text><Text className="payroll-grand-total">RM {money(totals.grand)}</Text></Box><Group className="payroll-total-breakdown" gap="xl"><TotalDatum label="Hours" value={number(totals.hours)} /><TotalDatum label="Salary" value={`RM ${money(totals.salary)}`} /><TotalDatum label="Petrol" value={`RM ${money(totals.petrol)}`} /><TotalDatum label={customLabel1 || 'Allowance 1'} value={`RM ${money(totals.custom1)}`} /><TotalDatum label={customLabel2 || 'Allowance 2'} value={`RM ${money(totals.custom2)}`} /></Group></Box>
    <Paper p={{ base: 'md', sm: 'lg' }} radius="lg" withBorder><Group justify="space-between" align="flex-start" mb="lg"><Box><Title order={3}>{dayjs(`${month}-01`).format('MMMM YYYY')} coach ledger</Title><Text size="sm" c="dimmed" mt={3}>Each added date becomes an hours column for every coach.</Text></Box><Group gap="xs"><TextInput label="Custom column 1" value={customLabel1} maxLength={60} onChange={(event) => { setCustomLabel1(event.currentTarget.value); setPayrollDirty(true) }} /><TextInput label="Custom column 2" value={customLabel2} maxLength={60} onChange={(event) => { setCustomLabel2(event.currentTarget.value); setPayrollDirty(true) }} /></Group></Group>
      {loading ? <PageLoader label="Loading payroll…" /> : rows.length ? <><Box visibleFrom="md"><Table.ScrollContainer minWidth={Math.max(1180, 870 + dates.length * 100)}><Table className="payroll-table payroll-grid-table" verticalSpacing="xs"><Table.Thead><Table.Tr><Table.Th rowSpan={dates.length ? 2 : 1} className="payroll-sticky coach">Coach</Table.Th><Table.Th rowSpan={dates.length ? 2 : 1} className="payroll-sticky branch">Branch</Table.Th><Table.Th rowSpan={dates.length ? 2 : 1} className="payroll-sticky salary-rate">Salary/hour</Table.Th><Table.Th rowSpan={dates.length ? 2 : 1} className="payroll-sticky petrol-rate">Petrol/day</Table.Th>{dates.length > 0 && <Table.Th colSpan={dates.length} ta="center" className="payroll-date-group">Hours by class date</Table.Th>}<Table.Th rowSpan={dates.length ? 2 : 1}>{customLabel1 || 'Allowance 1'}</Table.Th><Table.Th rowSpan={dates.length ? 2 : 1}>{customLabel2 || 'Allowance 2'}</Table.Th><Table.Th rowSpan={dates.length ? 2 : 1} className="payroll-sticky total">Total</Table.Th><Table.Th rowSpan={dates.length ? 2 : 1} className="payroll-sticky actions" /></Table.Tr>{dates.length > 0 && <Table.Tr>{dates.map((date) => <Table.Th key={date} ta="center"><Text size="xs" fw={800}>{dayjs(date).format('D MMM')}</Text></Table.Th>)}</Table.Tr>}</Table.Thead><Table.Tbody>{rows.map((row) => <PayrollRow key={row.clientId} row={row} dates={dates} coachOptions={coachOptions} branchOptions={branchOptions} onCoach={(value) => selectCoach(row, value)} onChange={updateRow} onHours={(date, hours) => updateHours(row, date, hours)} onDelete={() => removeRow(row)} />)}</Table.Tbody><Table.Tfoot><Table.Tr><Table.Th colSpan={4}>Monthly totals</Table.Th>{dates.map((date) => <Table.Th key={date}>{number(rows.reduce((sum, row) => sum + (row.hours[date] || 0), 0))}h</Table.Th>)}<Table.Th>RM {money(totals.custom1)}</Table.Th><Table.Th>RM {money(totals.custom2)}</Table.Th><Table.Th>RM {money(totals.grand)}</Table.Th><Table.Th /></Table.Tr></Table.Tfoot></Table></Table.ScrollContainer></Box><Stack hiddenFrom="md" gap="sm">{rows.map((row) => <PayrollCard key={row.clientId} row={row} dates={dates} labels={[customLabel1 || 'Allowance 1', customLabel2 || 'Allowance 2']} coachOptions={coachOptions} branchOptions={branchOptions} onCoach={(value) => selectCoach(row, value)} onChange={updateRow} onHours={(date, hours) => updateHours(row, date, hours)} onDelete={() => removeRow(row)} />)}</Stack></> : <EmptyState title="No coaches in this month" message="Add a coach row, then add only the dates classes were held." icon={IconUserStar} />}
    </Paper>
    <Box mt={42}><Group justify="space-between" mb="md"><Box><Title order={3}>Coach profiles</Title><Text size="sm" c="dimmed" mt={3}>Default rates are copied into new payroll rows and can be overridden there.</Text></Box><Badge variant="light" color="gray">{coaches.length} coaches</Badge></Group>{coaches.length ? <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }}>{coaches.map((item) => <Paper key={item.id} p="md" radius="lg" withBorder><Group align="flex-start" wrap="nowrap"><PersonAvatar name={item.name} src={publicImageUrl('coach-photos', item.photo_path)} size={54} onClick={() => setPhotoView({ src: publicImageUrl('coach-photos', item.photo_path), name: item.name })} /><Stack gap={4} flex={1} style={{ minWidth: 0 }}><Group justify="space-between" wrap="nowrap"><Text fw={800} truncate>{item.name}</Text><Group gap={2} wrap="nowrap"><ActionIcon aria-label={`Edit ${item.name}`} size={38} variant="subtle" color="gray" onClick={() => editCoach(item)}><IconEdit size={16} /></ActionIcon><ActionIcon aria-label={`Delete ${item.name}`} size={38} variant="subtle" color="red" onClick={() => removeCoach(item)}><IconTrash size={16} /></ActionIcon></Group></Group><Text size="xs" c="dimmed">{branches.find((branch) => branch.id === item.branch_id)?.name || 'Unknown branch'} · {item.coach_type}</Text><Group gap="xs"><Badge variant="light">RM {money(item.hourly_rate)}/h</Badge><Badge variant="light" color="teal">RM {money(item.petrol_day_rate)}/day</Badge><Badge variant="outline" color={item.status === 'Active' ? 'green' : 'gray'}>{item.status}</Badge></Group></Stack></Group></Paper>)}</SimpleGrid> : <EmptyState title="No coaches yet" message="Add a coach and set their default salary and petrol rates." icon={IconUserStar} />}</Box>
    <Modal opened={formOpened} onClose={closeForm} title={form.id ? `Edit ${form.name}` : 'Add coach'} centered size="lg"><Stack><Group justify="center"><Box className="profile-photo-editor"><PersonAvatar name={form.name || 'New coach'} src={publicImageUrl('coach-photos', form.photo_path || null)} size={92} onClick={() => setPhotoView({ src: publicImageUrl('coach-photos', form.photo_path || null), name: form.name || 'Coach photo' })} /><FileButton onChange={setPhoto} accept="image/png,image/jpeg,image/webp">{(props) => <ActionIcon {...props} className="profile-camera-button" aria-label="Choose coach photo" color="orange" size={32} radius="xl"><IconCamera size={16} /></ActionIcon>}</FileButton></Box></Group>{photo && <Text size="xs" c="orange" ta="center">New photo selected · save to upload</Text>}<Grid><Grid.Col span={{ base: 12, sm: 7 }}><TextInput label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></Grid.Col><Grid.Col span={{ base: 12, sm: 5 }}><TextInput label="Phone" value={form.phone || ''} onChange={(event) => setForm({ ...form, phone: event.currentTarget.value })} /></Grid.Col>{!form.id && <Grid.Col span={{ base: 12, sm: 4 }}><Select label="Home branch" value={form.branch_id ? String(form.branch_id) : String(branchId)} onChange={(value) => setForm({ ...form, branch_id: value ? Number(value) : branchId })} data={branchOptions} allowDeselect={false} /></Grid.Col>}<Grid.Col span={{ base: 6, sm: 4 }}><Select label="Type" value={form.coach_type} onChange={(value) => setForm({ ...form, coach_type: value as Coach['coach_type'] })} data={[{ value: 'Head', label: 'Head coach' }, { value: 'Assistant', label: 'Assistant coach' }]} /></Grid.Col><Grid.Col span={{ base: 6, sm: 4 }}><Select label="Status" value={form.status} onChange={(value) => setForm({ ...form, status: value as Coach['status'] })} data={['Active', 'Inactive']} /></Grid.Col><Grid.Col span={{ base: 12, sm: 6 }}><NumberInput label="Default salary/hour (RM)" value={form.hourly_rate || 0} onChange={(value) => setForm({ ...form, hourly_rate: numeric(value) })} min={0} decimalScale={2} /></Grid.Col><Grid.Col span={{ base: 12, sm: 6 }}><NumberInput label="Default petrol/day (RM)" value={form.petrol_day_rate || 0} onChange={(value) => setForm({ ...form, petrol_day_rate: numeric(value) })} min={0} decimalScale={2} /></Grid.Col></Grid><Group justify="flex-end"><Button variant="default" disabled={saving} onClick={closeForm}>Cancel</Button><Button onClick={submitCoach} loading={saving}>Save coach</Button></Group></Stack></Modal>
    <Modal opened={datesOpened} onClose={datesModal.close} title={`Manage ${dayjs(`${month}-01`).format('MMMM YYYY')} dates`} centered><Stack><Text size="sm" c="dimmed">Add only dates when classes were held. Every date becomes an hours field for all coaches.</Text><Group align="end" wrap="nowrap"><TextInput type="date" label="Class date" value={dateDraft} min={`${month}-01`} max={dayjs(`${month}-01`).endOf('month').format('YYYY-MM-DD')} onChange={(event) => setDateDraft(event.currentTarget.value)} flex={1} /><Button leftSection={<IconCalendarPlus size={17} />} onClick={addDate} disabled={!dateDraft}>Add</Button></Group>{dates.length ? <Stack gap="xs">{dates.map((date) => <Paper key={date} p="sm" radius="md" withBorder><Group justify="space-between"><Box><Text fw={700}>{dayjs(date).format('dddd, D MMMM')}</Text><Text size="xs" c="dimmed">Hours column</Text></Box><ActionIcon aria-label={`Remove ${dayjs(date).format('D MMMM')}`} color="red" variant="subtle" onClick={() => removeDate(date)}><IconTrash size={17} /></ActionIcon></Group></Paper>)}</Stack> : <Text size="sm" c="dimmed" ta="center" py="lg">No class dates added yet.</Text>}<Button variant="default" onClick={datesModal.close}>Done</Button></Stack></Modal>
    {payrollDirty && <Box className="payroll-mobile-save" hiddenFrom="md"><Group justify="space-between"><Box><Text fw={800}>Unsaved payroll</Text><Text size="xs" c="dimmed">Review and save this month</Text></Box><Button leftSection={<IconDeviceFloppy size={17} />} onClick={savePayroll} loading={saving}>Save</Button></Group></Box>}
    <PhotoLightbox src={photoView?.src || null} name={photoView?.name || 'Coach photo'} opened={Boolean(photoView)} onClose={() => setPhotoView(null)} />
  </>
}

interface PayrollEditorProps { row: PayrollDraft; dates: string[]; coachOptions: Array<{ value: string; label: string }>; branchOptions: Array<{ value: string; label: string }>; onCoach: (value: string | null) => void; onChange: <K extends keyof PayrollDraft>(clientId: string, field: K, value: PayrollDraft[K]) => void; onHours: (date: string, hours: number) => void; onDelete: () => void }

function PayrollRow({ row, dates, coachOptions, branchOptions, onCoach, onChange, onHours, onDelete }: PayrollEditorProps) {
  return <Table.Tr><Table.Td className="payroll-sticky coach"><Select aria-label="Coach" searchable value={row.coach_id ? String(row.coach_id) : null} onChange={onCoach} data={coachOptions} w={180} /></Table.Td><Table.Td className="payroll-sticky branch"><Select aria-label="Branch" value={row.branch_id ? String(row.branch_id) : null} onChange={(value) => onChange(row.clientId, 'branch_id', value ? Number(value) : null)} data={branchOptions} w={150} /></Table.Td><Table.Td className="payroll-sticky salary-rate"><MoneyInput label="Salary per hour" value={row.hourly_rate} onChange={(value) => onChange(row.clientId, 'hourly_rate', value)} /></Table.Td><Table.Td className="payroll-sticky petrol-rate"><MoneyInput label="Petrol per day" value={row.petrol_day_rate} onChange={(value) => onChange(row.clientId, 'petrol_day_rate', value)} /></Table.Td>{dates.map((date) => <Table.Td key={date}><NumberInput aria-label={`${dayjs(date).format('D MMM')} hours`} value={row.hours[date] || 0} min={0} decimalScale={2} step={0.5} hideControls onChange={(value) => onHours(date, numeric(value))} w={78} /></Table.Td>)}<Table.Td><MoneyInput label="First custom allowance" value={row.custom_amount_1} onChange={(value) => onChange(row.clientId, 'custom_amount_1', value)} /></Table.Td><Table.Td><MoneyInput label="Second custom allowance" value={row.custom_amount_2} onChange={(value) => onChange(row.clientId, 'custom_amount_2', value)} /></Table.Td><Table.Td className="payroll-sticky total"><Text fw={850} className="payroll-row-total">RM {money(total(row))}</Text><Text size="xs" c="dimmed">{number(rowHours(row))}h · {workedDays(row)} days</Text></Table.Td><Table.Td className="payroll-sticky actions"><ActionIcon aria-label="Delete coach payroll row" variant="subtle" color="red" onClick={onDelete}><IconTrash size={16} /></ActionIcon></Table.Td></Table.Tr>
}

function PayrollCard({ row, dates, labels, coachOptions, branchOptions, onCoach, onChange, onHours, onDelete }: PayrollEditorProps & { labels: [string, string] }) {
  const [opened, setOpened] = useState(!row.coach_id)
  const coachName = coachOptions.find((item) => item.value === String(row.coach_id))?.label || 'Select coach'
  const branchName = branchOptions.find((item) => item.value === String(row.branch_id))?.label || 'No branch'
  return <Paper className="payroll-mobile-card" radius="md" withBorder><button type="button" className="payroll-mobile-card-header" aria-expanded={opened} onClick={() => setOpened((current) => !current)}><Box ta="left"><Text fw={850}>{coachName}</Text><Text size="xs" c="dimmed">{branchName} · {number(rowHours(row))}h · {workedDays(row)} days</Text></Box><Group gap="sm" wrap="nowrap"><Text fw={900}>RM {money(total(row))}</Text><IconChevronDown className={opened ? 'open' : ''} size={19} /></Group></button><Collapse in={opened}><Box p="md" pt={0}><Grid gutter="xs"><Grid.Col span={12}><Select label="Coach" searchable value={row.coach_id ? String(row.coach_id) : null} onChange={onCoach} data={coachOptions} /></Grid.Col><Grid.Col span={12}><Select label="Branch" value={row.branch_id ? String(row.branch_id) : null} onChange={(value) => onChange(row.clientId, 'branch_id', value ? Number(value) : null)} data={branchOptions} /></Grid.Col><Grid.Col span={6}><NumberInput label="Salary/hour" prefix="RM " value={row.hourly_rate} min={0} decimalScale={2} onChange={(value) => onChange(row.clientId, 'hourly_rate', numeric(value))} /></Grid.Col><Grid.Col span={6}><NumberInput label="Petrol/day" prefix="RM " value={row.petrol_day_rate} min={0} decimalScale={2} onChange={(value) => onChange(row.clientId, 'petrol_day_rate', numeric(value))} /></Grid.Col>{dates.map((date) => <Grid.Col span={6} key={date}><NumberInput label={`${dayjs(date).format('D MMM')} hours`} value={row.hours[date] || 0} min={0} decimalScale={2} step={0.5} onChange={(value) => onHours(date, numeric(value))} /></Grid.Col>)}<Grid.Col span={6}><NumberInput label={labels[0]} prefix="RM " value={row.custom_amount_1} min={0} decimalScale={2} onChange={(value) => onChange(row.clientId, 'custom_amount_1', numeric(value))} /></Grid.Col><Grid.Col span={6}><NumberInput label={labels[1]} prefix="RM " value={row.custom_amount_2} min={0} decimalScale={2} onChange={(value) => onChange(row.clientId, 'custom_amount_2', numeric(value))} /></Grid.Col></Grid><Group justify="space-between" mt="md" pt="sm" className="payroll-mobile-calculation"><Box><Text size="xs" c="dimmed">Salary</Text><Text fw={750}>RM {money(salary(row))}</Text></Box><Box ta="center"><Text size="xs" c="dimmed">Petrol</Text><Text fw={750}>RM {money(petrol(row))}</Text></Box><ActionIcon aria-label="Delete coach payroll row" variant="light" color="red" onClick={onDelete}><IconTrash size={16} /></ActionIcon></Group></Box></Collapse></Paper>
}

function MoneyInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <NumberInput aria-label={label} prefix="RM " value={value} min={0} decimalScale={2} hideControls onChange={(next) => onChange(numeric(next))} w={105} /> }
function TotalDatum({ label, value }: { label: string; value: string }) { return <Box><Text size="xs">{label}</Text><Text fw={800}>{value}</Text></Box> }
function toDraft(row: CoachPayrollRow): PayrollDraft { return { clientId: `saved-${row.id}`, id: row.id, coach_id: row.coach_id, branch_id: row.branch_id, hourly_rate: Number(row.hourly_rate), petrol_day_rate: Number(row.petrol_day_rate), custom_amount_1: Number(row.custom_amount_1), custom_amount_2: Number(row.custom_amount_2), hours: Object.fromEntries(row.hours.map((entry) => [entry.work_date, Number(entry.hours)])) } }
function rowHours(row: PayrollDraft) { return Object.values(row.hours).reduce((sum, hours) => sum + hours, 0) }
function workedDays(row: PayrollDraft) { return Object.values(row.hours).filter((hours) => hours > 0).length }
function salary(row: PayrollDraft) { return rowHours(row) * row.hourly_rate }
function petrol(row: PayrollDraft) { return workedDays(row) * row.petrol_day_rate }
function total(row: PayrollDraft) { return salary(row) + petrol(row) + row.custom_amount_1 + row.custom_amount_2 }
function numeric(value: string | number) { return value === '' ? 0 : Number(value) }
function money(value: number) { return Number(value).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function number(value: number) { return Number(value).toLocaleString('en-MY', { maximumFractionDigits: 2 }) }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong' }
