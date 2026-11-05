import { useEffect, useMemo, useRef, useState, type ComponentPropsWithRef } from 'react'
import dayjs from 'dayjs'
import { Alert, Badge, Box, Button, Collapse, Group, NumberInput, Paper, Popover, Select, SimpleGrid, Skeleton, Stack, Table, Text, TextInput, Textarea, UnstyledButton } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { IconCheck, IconClipboard, IconNote, IconPlus, IconSearch, IconUsers } from '@tabler/icons-react'
import { getReportLedger, recordStudentPayment, saveMonthRemark } from '../lib/api'
import { findDuplicateReference } from '../lib/paymentOperations'
import { publicImageUrl } from '../lib/supabase'
import { EmptyState, PageHeader, PersonAvatar, ResponsiveModal } from '../components/ui'
import { StudentsPage } from './StudentsPage'
import type { AcademyClass, BootstrapData, Enrollment, Payment, PaymentMethod, PaymentStatus, Student } from '../types/models'

type Ledger = Awaited<ReturnType<typeof getReportLedger>>
type CellStatus = 'paid' | 'partial' | 'unpaid' | 'outstanding' | 'not-enrolled' | 'not-due'
type MonthCell = { month: string; status: CellStatus; attended: number; scheduled: number; dates: string[]; payments: Payment[]; remark: string }
type LedgerRow = { student: Student; classLabel: string; dayOrder: number; age: number | null; attended: number; scheduled: number; months: MonthCell[] }

const methods: PaymentMethod[] = ['Cash', 'Bank Transfer', "Touch 'n Go eWallet", 'Online', 'Others']
const statuses: PaymentStatus[] = ['Paid', 'Partial', 'Unpaid']
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const statusLabels: Record<CellStatus, string> = { paid: 'Paid', partial: 'Partial', unpaid: 'Unpaid', outstanding: 'Outstanding', 'not-enrolled': 'Not enrolled', 'not-due': 'Not due' }
const legend: CellStatus[] = ['paid', 'partial', 'unpaid', 'outstanding', 'not-enrolled']
type ReportPeriod = '3' | '6' | '12' | 'year'
const periodOptions = [{ value: '3', label: '3 months' }, { value: '6', label: '6 months' }, { value: '12', label: '12 months' }, { value: 'year', label: 'Full year' }]
const popoverMiddlewares = {
  flip: { fallbackPlacements: ['top', 'left', 'right'] as Array<'top' | 'left' | 'right'>, fallbackStrategy: 'bestFit' as const, padding: 12 },
  shift: { padding: 12 },
  size: { padding: 12, apply: ({ availableHeight, elements }: { availableHeight: number; elements: { floating: HTMLElement } }) => { elements.floating.style.maxHeight = `${Math.max(240, Math.min(availableHeight, 640))}px` } },
}
const chipTones = ['amber', 'pink', 'violet', 'blue', 'green', 'orange', 'slate']

export function ReportsPage({ branchId, data, onChanged }: { branchId: number; data: BootstrapData; onChanged: () => Promise<unknown> }) {
  const [year, setYear] = useState(dayjs().format('YYYY'))
  const [period, setPeriod] = useState<ReportPeriod>('year')
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadRequest, setReloadRequest] = useState(0)
  const [search, setSearch] = useState('')
  const [classFilter, setClassFilter] = useState<string | null>(null)
  const [active, setActive] = useState<{ studentId: number; month: string } | null>(null)
  const [detailStudent, setDetailStudent] = useState<Student | null>(null)
  const [detailRequest, setDetailRequest] = useState(0)
  const isMobile = useMediaQuery('(max-width: 62em)')
  const currentMonth = dayjs().format('YYYY-MM')
  const monthKeys = useMemo(() => {
    if (period === 'year') return Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`)
    const count = Number(period)
    return Array.from({ length: count }, (_, index) => dayjs(`${currentMonth}-01`).subtract(count - 1 - index, 'month').format('YYYY-MM'))
  }, [currentMonth, period, year])
  const rangeStart = `${monthKeys[0]}-01`
  const rangeEnd = dayjs(`${monthKeys.at(-1)}-01`).endOf('month').format('YYYY-MM-DD')
  const spansYears = monthKeys[0].slice(0, 4) !== monthKeys.at(-1)!.slice(0, 4)
  const periodLabel = period === 'year' ? year : `${dayjs(rangeStart).format('MMM YYYY')} – ${dayjs(rangeEnd).format('MMM YYYY')}`
  const monthHeader = (month: string) => dayjs(`${month}-01`).format(spansYears ? 'MMM YY' : 'MMM')
  const years = Array.from({ length: 8 }, (_, index) => String(dayjs().year() - index))

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError('')
    getReportLedger(branchId, rangeStart, rangeEnd)
      .then((next) => { if (alive) setLedger(next) })
      .catch((error) => { if (alive) { setLedger(null); setLoadError(errorMessage(error)) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [branchId, rangeEnd, rangeStart, reloadRequest])

  const rows = useMemo(() => {
    if (!ledger) return []
    const classById = new Map(data.classes.map((item) => [item.id, item]))
    const sessionDates = new Map<number, string[]>()
    ledger.sessions.forEach((session) => sessionDates.set(session.class_id, [...(sessionDates.get(session.class_id) || []), session.session_date]))
    const attendanceByStudent = new Map<number, Ledger['attendance']>()
    ledger.attendance.filter((record) => !record.is_trial).forEach((record) => attendanceByStudent.set(record.student_id, [...(attendanceByStudent.get(record.student_id) || []), record]))
    const remarks = new Map(ledger.remarks.map((item) => [`${item.student_id}:${item.month.slice(0, 7)}`, item.remark]))
    const rangePayments = data.payments.filter((payment) => payment.fee_month >= rangeStart && payment.fee_month <= rangeEnd)

    return data.students.flatMap((student): LedgerRow[] => {
      const enrollments = data.enrollments.filter((entry) => entry.student_id === student.id)
      const rangeEnrollments = enrollments.filter((entry) => entry.start_date <= rangeEnd && (!entry.end_date || entry.end_date >= rangeStart))
      const attendance = attendanceByStudent.get(student.id) || []
      const payments = rangePayments.filter((payment) => payment.student_id === student.id)
      const include = student.status === 'Active' ? rangeEnrollments.length > 0 : student.status === 'Inactive' && (rangeEnrollments.length > 0 || attendance.length > 0 || payments.length > 0)
      if (!include) return []

      const covering = (classId: number, date: string) => enrollments.some((entry) => entry.class_id === classId && entry.start_date <= date && (!entry.end_date || entry.end_date >= date))
      const classes = [...new Map(rangeEnrollments.map((entry) => [entry.class_id, classById.get(entry.class_id)])).values()].filter((item): item is AcademyClass => Boolean(item)).sort((a, b) => days.indexOf(a.day_of_week) - days.indexOf(b.day_of_week) || a.label.localeCompare(b.label))
      const classIds = new Set(enrollments.map((entry) => entry.class_id))
      const months = monthKeys.map((month): MonthCell => {
        const scheduled = [...classIds].reduce((sum, classId) => sum + (sessionDates.get(classId) || []).filter((date) => date.startsWith(month) && covering(classId, date)).length, 0)
        const dates = attendance.filter((record) => record.attendance_date.startsWith(month) && covering(record.class_id, record.attendance_date)).map((record) => record.attendance_date).sort()
        const monthPayments = payments.filter((payment) => payment.fee_month.startsWith(month))
        return { month, status: cellStatus(student, enrollments, monthPayments, month, currentMonth), attended: dates.length, scheduled, dates, payments: monthPayments, remark: remarks.get(`${student.id}:${month}`) || '' }
      })
      const counted = months.filter((cell) => cell.month <= currentMonth)
      return [{
        student,
        classLabel: classes.map((item) => item.short_label?.trim() || item.day_of_week.slice(0, 3)).join(' & ') || '—',
        dayOrder: classes.length ? days.indexOf(classes[0].day_of_week) * 10 + classes.length : 99,
        age: student.date_of_birth ? dayjs().diff(dayjs(student.date_of_birth), 'year') : student.age ?? null,
        attended: counted.reduce((sum, cell) => sum + cell.attended, 0),
        scheduled: counted.reduce((sum, cell) => sum + cell.scheduled, 0),
        months,
      }]
    }).sort((a, b) => a.dayOrder - b.dayOrder || a.classLabel.localeCompare(b.classLabel) || a.student.name.localeCompare(b.student.name))
  }, [currentMonth, data.classes, data.enrollments, data.payments, data.students, ledger, monthKeys, rangeEnd, rangeStart])

  const classOptions = useMemo(() => [...new Set(rows.map((row) => row.classLabel))], [rows])
  const needle = search.trim().toLowerCase()
  const visibleRows = rows.filter((row) => (!classFilter || row.classLabel === classFilter) && (!needle || row.student.name.toLowerCase().includes(needle)))
  const activeRow = active ? rows.find((row) => row.student.id === active.studentId) : undefined
  const activeCell = activeRow?.months.find((cell) => cell.month === active?.month)

  function openStudent(student: Student) {
    setActive(null)
    setDetailStudent(student)
    setDetailRequest((current) => current + 1)
  }

  function open(studentId: number, month: string) {
    setActive((current) => current?.studentId === studentId && current.month === month ? null : { studentId, month })
  }

  function updateRemark(studentId: number, month: string, remark: string) {
    setLedger((current) => current && { ...current, remarks: [...current.remarks.filter((item) => !(item.student_id === studentId && item.month.startsWith(month))), ...(remark ? [{ id: 0, branch_id: branchId, student_id: studentId, month: `${month}-01`, remark }] : [])] })
  }

  async function copyReport() {
    const heading = ['No.', 'Class', 'Student', 'Attendance', ...monthKeys.map(monthHeader)]
    const body = visibleRows.map((row, index) => [index + 1, row.classLabel, row.student.name, `${row.attended}/${row.scheduled}`, ...row.months.map((cell) => [statusLabels[cell.status], attendanceText(cell, currentMonth), cell.remark].filter(Boolean).join(' · '))])
    try {
      await navigator.clipboard.writeText([heading, ...body].map((cells) => cells.map((cell) => String(cell).replace(/\t|\r?\n/g, ' ')).join('\t')).join('\n'))
      notifications.show({ color: 'green', message: `${periodLabel} ledger copied` })
    } catch {
      notifications.show({ color: 'red', message: 'Clipboard access was not available' })
    }
  }

  const panel = activeRow && activeCell ? <MonthPanel key={`${activeRow.student.id}:${activeCell.month}`} branchId={branchId} data={data} row={activeRow} cell={activeCell} currentMonth={currentMonth} portalDropdowns={Boolean(isMobile)} onRemarkSaved={updateRemark} onPaymentSaved={async () => { setActive(null); try { await onChanged() } catch (error) { notifications.show({ color: 'orange', title: 'Payment saved, refresh failed', message: errorMessage(error) }) } }} /> : null

  return <>
    <PageHeader title="Reports" description="Attendance and fee ledger for every student" action={<Group gap="xs"><Select aria-label="Report period" value={period} onChange={(value) => { setPeriod((value as ReportPeriod) || 'year'); setActive(null) }} data={periodOptions} allowDeselect={false} w={130} />{period === 'year' && <Select aria-label="Report year" value={year} onChange={(value) => { setYear(value || dayjs().format('YYYY')); setActive(null) }} data={years} allowDeselect={false} w={100} />}<Button variant="light" leftSection={<IconClipboard size={17} />} onClick={copyReport} disabled={!visibleRows.length}>Copy</Button></Group>} />

    <Paper radius="lg" withBorder className="ledger-card">
      <Box p="lg" pb="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Box><Text fw={800} size="lg">Student ledger</Text><Text c="dimmed" size="sm">Colour shows the month’s payment status; numbers show classes attended / scheduled. Select a month to add a payment or note.</Text></Box>
          <Badge variant="light" size="lg">{periodLabel}</Badge>
        </Group>
        <Group mt="md" gap="sm" wrap="wrap">
          <TextInput className="ledger-search" aria-label="Search ledger students by name" leftSection={<IconSearch size={16} />} placeholder="Search student name…" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          <Select aria-label="Filter ledger by class" placeholder="All classes" clearable value={classFilter} onChange={setClassFilter} data={classOptions} w={180} />
        </Group>
        <Group mt="md" gap="lg" wrap="wrap" className="ledger-legend" role="list" aria-label="Legend">
          {legend.map((status) => <Group key={status} gap={6} wrap="nowrap" role="listitem"><span className="ledger-swatch" data-status={status} /><Text size="xs" fw={600}>{statusLabels[status]}</Text></Group>)}
          <Group gap={6} wrap="nowrap" role="listitem"><span className="ledger-swatch ledger-swatch-note" /><Text size="xs" fw={600}>Has note</Text></Group>
        </Group>
        {ledger && <Text size="xs" c="dimmed" mt="sm">{visibleRows.length === rows.length ? `${rows.length} student${rows.length === 1 ? '' : 's'}` : `${visibleRows.length} of ${rows.length} students`}{loading ? ' · Refreshing…' : ''}</Text>}
      </Box>

      {loadError ? <Box p="lg" pt={0}><Alert color="red" title="Could not load ledger">{loadError}<Button mt="md" size="xs" onClick={() => setReloadRequest((current) => current + 1)}>Retry</Button></Alert></Box>
        : !ledger ? <Stack p="lg" pt={0} gap="xs" role="status" aria-label="Loading ledger">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} height={44} radius="sm" />)}</Stack>
          : !visibleRows.length ? <Box p="lg" pt={0}><EmptyState title="No students to show" message={rows.length ? 'No student matches this search or class filter.' : `No enrolled students for ${periodLabel}.`} icon={IconUsers} /></Box>
            : isMobile ? <Stack p="md" pt={0} gap="sm">{visibleRows.map((row) => <LedgerCard key={row.student.id} row={row} currentMonth={currentMonth} onOpen={(month) => open(row.student.id, month)} onOpenStudent={() => openStudent(row.student)} />)}</Stack>
              : <Box className="ledger-scroll">
                <Table className="ledger-table" style={{ minWidth: 456 + monthKeys.length * 72 }}>
                  <Table.Thead><Table.Tr>
                    <Table.Th className="ledger-sticky ledger-col-no">No.</Table.Th>
                    <Table.Th className="ledger-sticky ledger-col-class">Class</Table.Th>
                    <Table.Th className="ledger-sticky ledger-col-student">Student</Table.Th>
                    <Table.Th className="ledger-sticky ledger-col-attendance">Attendance</Table.Th>
                    {monthKeys.map((month) => <Table.Th key={month} className={month === currentMonth ? 'ledger-month is-current' : 'ledger-month'}>{monthHeader(month)}</Table.Th>)}
                  </Table.Tr></Table.Thead>
                  <Table.Tbody>{visibleRows.map((row, index) => <Table.Tr key={row.student.id} className={row.student.status === 'Active' ? undefined : 'is-inactive'}>
                    <Table.Td className="ledger-sticky ledger-col-no">{index + 1}</Table.Td>
                    <Table.Td className="ledger-sticky ledger-col-class"><ClassChip label={row.classLabel} /></Table.Td>
                    <Table.Td className="ledger-sticky ledger-col-student"><StudentLabel row={row} onOpen={() => openStudent(row.student)} /></Table.Td>
                    <Table.Td className="ledger-sticky ledger-col-attendance"><AttendanceTotal row={row} /></Table.Td>
                    {row.months.map((cell) => {
                      const opened = active?.studentId === row.student.id && active.month === cell.month
                      return <Table.Td key={cell.month} className={cell.month === currentMonth ? 'ledger-month-cell is-current' : 'ledger-month-cell'}>
                        <Popover opened={opened} onChange={(next) => { if (!next) setActive(null) }} width={360} position="bottom" withArrow shadow="lg" trapFocus middlewares={popoverMiddlewares}>
                          <Popover.Target><MonthButton row={row} cell={cell} currentMonth={currentMonth} opened={opened} onClick={() => open(row.student.id, cell.month)} /></Popover.Target>
                          <Popover.Dropdown className="ledger-popover">{opened && panel}</Popover.Dropdown>
                        </Popover>
                      </Table.Td>
                    })}
                  </Table.Tr>)}</Table.Tbody>
                </Table>
              </Box>}
    </Paper>

    {isMobile && <ResponsiveModal opened={Boolean(panel)} onClose={() => setActive(null)} title="Month details">{panel}</ResponsiveModal>}
    <StudentsPage branchId={branchId} data={data} isAdmin dialogOnly dialogStudent={detailStudent} dialogRequest={detailRequest} onDialogClose={() => setDetailStudent(null)} onChanged={onChanged} />
  </>
}

function MonthButton({ row, cell, currentMonth, opened, onClick, compact, ...rest }: { row: LedgerRow; cell: MonthCell; currentMonth: string; opened?: boolean; onClick: () => void; compact?: boolean } & Omit<ComponentPropsWithRef<'button'>, 'onClick'>) {
  const attendance = attendanceText(cell, currentMonth)
  return <button {...rest} type="button" className={compact ? 'ledger-cell ledger-cell-compact' : 'ledger-cell'} data-status={cell.status} aria-expanded={opened} aria-label={`${row.student.name}, ${dayjs(`${cell.month}-01`).format('MMMM')}: ${statusLabels[cell.status]}${attendance ? `, attended ${cell.attended} of ${cell.scheduled}` : ''}${cell.remark ? ', has note' : ''}`} onClick={onClick}>
    {compact && <span className="ledger-cell-month">{dayjs(`${cell.month}-01`).format('MMM')}</span>}
    <span className="ledger-cell-value">{attendance || (cell.status === 'not-enrolled' ? '—' : '')}</span>
    {cell.remark && <span className="ledger-note-flag" aria-hidden="true" />}
  </button>
}

function LedgerCard({ row, currentMonth, onOpen, onOpenStudent }: { row: LedgerRow; currentMonth: string; onOpen: (month: string) => void; onOpenStudent: () => void }) {
  return <Paper p="md" radius="md" withBorder className={row.student.status === 'Active' ? 'ledger-mobile-card' : 'ledger-mobile-card is-inactive'}>
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <StudentLabel row={row} onOpen={onOpenStudent} />
      <AttendanceTotal row={row} />
    </Group>
    <Box mt="xs"><ClassChip label={row.classLabel} /></Box>
    <SimpleGrid cols={6} spacing={6} mt="sm">{row.months.map((cell) => <MonthButton key={cell.month} row={row} cell={cell} currentMonth={currentMonth} onClick={() => onOpen(cell.month)} compact />)}</SimpleGrid>
  </Paper>
}

function StudentLabel({ row, onOpen }: { row: LedgerRow; onOpen: () => void }) {
  return <UnstyledButton className="ledger-student-button" aria-label={`Open ${row.student.name} details`} onClick={onOpen}>
    <Group gap="sm" wrap="nowrap" miw={0}>
      <PersonAvatar name={row.student.name} src={publicImageUrl('student-photos', row.student.photo_path)} size={34} />
      <Box miw={0}>
        <Text fw={700} size="sm" truncate="end" className="ledger-student-name">{row.student.name}</Text>
        <Text size="xs" c="dimmed">{row.student.status === 'Active' ? row.age != null ? `Age ${row.age}` : 'Age not set' : 'Inactive'}</Text>
      </Box>
    </Group>
  </UnstyledButton>
}

function AttendanceTotal({ row }: { row: LedgerRow }) {
  return <Box className="ledger-attendance-total">
    <Text fw={800} size="sm">{row.attended} / {row.scheduled}</Text>
    <Text size="xs" c="dimmed">{row.scheduled ? `${Math.round((row.attended / row.scheduled) * 100)}%` : 'No sessions'}</Text>
  </Box>
}

function ClassChip({ label }: { label: string }) {
  const tone = chipTones[[...label].reduce((sum, char) => sum + char.charCodeAt(0), 0) % chipTones.length]
  return <span className="ledger-class-chip" data-tone={tone} title={label}>{label}</span>
}

function MonthPanel({ branchId, data, row, cell, currentMonth, portalDropdowns, onRemarkSaved, onPaymentSaved }: {
  branchId: number
  data: BootstrapData
  row: LedgerRow
  cell: MonthCell
  currentMonth: string
  portalDropdowns: boolean
  onRemarkSaved: (studentId: number, month: string, remark: string) => void
  onPaymentSaved: () => Promise<void>
}) {
  const hasPaid = cell.payments.some((payment) => payment.status === 'Paid')
  const [remark, setRemark] = useState(cell.remark)
  const [formOpen, setFormOpen] = useState(!hasPaid)
  const [amount, setAmount] = useState<number | string>(row.student.monthly_fee ?? '')
  const [status, setStatus] = useState<PaymentStatus | null>('Paid')
  const [method, setMethod] = useState<PaymentMethod | null>('Bank Transfer')
  const [dateReceived, setDateReceived] = useState(dayjs().format('YYYY-MM-DD'))
  const [referenceNo, setReferenceNo] = useState('')
  const [paymentRemarks, setPaymentRemarks] = useState('')
  const [savingRemark, setSavingRemark] = useState(false)
  const [savingPayment, setSavingPayment] = useState(false)
  const submitLock = useRef(false)
  const attendance = attendanceText(cell, currentMonth)
  const monthLabel = dayjs(`${cell.month}-01`).format('MMMM YYYY')
  const comboboxProps = { withinPortal: portalDropdowns }
  const paymentValidation = amount === '' || !status ? '' : status === 'Unpaid' && Number(amount) > 0 ? 'Unpaid records must have RM0 received.' : status !== 'Unpaid' && Number(amount) <= 0 ? `${status} records require an amount greater than RM0.` : ''

  async function submitRemark() {
    setSavingRemark(true)
    try {
      await saveMonthRemark(branchId, row.student.id, cell.month, remark)
      onRemarkSaved(row.student.id, cell.month, remark.trim())
      notifications.show({ color: 'green', message: remark.trim() ? 'Note saved' : 'Note removed' })
    } catch (error) {
      notifications.show({ color: 'red', title: 'Could not save note', message: errorMessage(error) })
    } finally {
      setSavingRemark(false)
    }
  }

  async function submitPayment() {
    if (amount === '' || !status || !method || !dateReceived || paymentValidation || submitLock.current) return
    submitLock.current = true
    setSavingPayment(true)
    try {
      const duplicate = await findDuplicateReference(branchId, referenceNo)
      if (duplicate && !window.confirm(`Reference already exists for ${duplicate.student?.name || 'another student'} (${dayjs(duplicate.fee_month).format('MMM YYYY')}). Save anyway?`)) return
      const enrollment = data.enrollments.find((item) => item.student_id === row.student.id && !item.end_date)
      const coachId = data.classes.find((item) => item.id === enrollment?.class_id)?.coach_id || null
      await recordStudentPayment({ studentId: row.student.id, feeMonths: [cell.month], amount: Number(amount), method, status, dateReceived, remarks: paymentRemarks, referenceNo, coachId, receiptPath: null })
      notifications.show({ color: 'green', title: 'Payment recorded', message: `${row.student.name} · ${monthLabel}` })
      await onPaymentSaved()
    } catch (error) {
      notifications.show({ color: 'red', title: 'Could not save payment', message: errorMessage(error) })
    } finally {
      submitLock.current = false
      setSavingPayment(false)
    }
  }

  return <Stack gap="md" className="ledger-panel">
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <Box miw={0}>
        <Text fw={800} truncate="end">{row.student.name}</Text>
        <Text size="sm" c="dimmed">{monthLabel} · RM {money(row.student.monthly_fee || 0)} / month</Text>
      </Box>
      <span className="ledger-status-pill" data-status={cell.status}>{statusLabels[cell.status]}</span>
    </Group>

    <Box>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed">Attendance</Text>
      <Text size="sm" fw={650} mt={2}>{attendance ? `${cell.attended} of ${cell.scheduled} classes attended` : cell.month > currentMonth ? 'Upcoming month' : 'No classes scheduled'}</Text>
      {cell.dates.length > 0 && <Group gap={6} mt={6}>{cell.dates.map((date, index) => <Badge key={`${date}-${index}`} variant="light" color="green" leftSection={<IconCheck size={11} />}>{dayjs(date).format('D MMM')}</Badge>)}</Group>}
    </Box>

    {cell.payments.length > 0 && <Box>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed">Payments</Text>
      <Stack gap={6} mt={4}>{cell.payments.map((payment) => <Box key={payment.id} className="ledger-payment-line">
        <Group justify="space-between" wrap="nowrap"><Text size="sm" fw={700}>RM {money(payment.amount)}</Text><span className="ledger-status-pill" data-status={payment.status.toLowerCase()}>{payment.status}</span></Group>
        <Text size="xs" c="dimmed">{[payment.method || 'No method', payment.date_received ? dayjs(payment.date_received).format('D MMM YYYY') : null, payment.reference_no || null].filter(Boolean).join(' · ')}</Text>
        {payment.remarks && <Text size="xs" mt={2}>{payment.remarks}</Text>}
      </Box>)}</Stack>
    </Box>}

    <Box>
      <Textarea label="Month note" leftSection={<IconNote size={15} />} placeholder="e.g. On leave, replacement class on 25/4" autosize minRows={2} maxRows={4} value={remark} onChange={(event) => setRemark(event.currentTarget.value)} />
      <Group justify="flex-end" mt={6}><Button size="xs" variant="light" onClick={submitRemark} loading={savingRemark} disabled={remark.trim() === cell.remark}>Save note</Button></Group>
    </Box>

    {hasPaid && !formOpen && <Button variant="subtle" size="xs" leftSection={<IconPlus size={14} />} onClick={() => setFormOpen(true)}>Add another payment</Button>}
    <Collapse in={formOpen}>
      <Stack gap="xs" className="ledger-payment-form">
        <Text size="xs" fw={700} tt="uppercase" c="dimmed">Record payment for {dayjs(`${cell.month}-01`).format('MMM YYYY')}</Text>
        <Group grow gap="xs"><NumberInput label="Amount (RM)" value={amount} onChange={setAmount} min={0} decimalScale={2} required /><Select label="Status" value={status} onChange={(value) => setStatus(value as PaymentStatus)} data={statuses} allowDeselect={false} comboboxProps={comboboxProps} /></Group>
        <Group grow gap="xs"><Select label="Method" value={method} onChange={(value) => setMethod(value as PaymentMethod)} data={methods} allowDeselect={false} comboboxProps={comboboxProps} /><TextInput label="Date received" type="date" value={dateReceived} onChange={(event) => setDateReceived(event.currentTarget.value)} required /></Group>
        <TextInput label="Reference number" value={referenceNo} onChange={(event) => setReferenceNo(event.currentTarget.value)} />
        <TextInput label="Payment remarks" placeholder="e.g. includes registration fee" value={paymentRemarks} onChange={(event) => setPaymentRemarks(event.currentTarget.value)} />
        {paymentValidation && <Text size="xs" c="red">{paymentValidation}</Text>}
        <Button mt={4} onClick={submitPayment} loading={savingPayment} disabled={amount === '' || !dateReceived || Boolean(paymentValidation)}>Save payment</Button>
      </Stack>
    </Collapse>
  </Stack>
}

function cellStatus(student: Student, enrollments: Enrollment[], payments: Payment[], month: string, currentMonth: string): CellStatus {
  if (payments.some((payment) => payment.status === 'Paid')) return 'paid'
  const enrolled = enrollments.some((entry) => entry.start_date.slice(0, 7) <= month && (!entry.end_date || entry.end_date.slice(0, 7) >= month))
  if (enrolled && month <= currentMonth) {
    const received = payments.filter((payment) => payment.status === 'Partial').reduce((sum, payment) => sum + Number(payment.amount), 0)
    if (Number(student.monthly_fee || 0) - received <= 0) return 'paid'
    if (received > 0) return 'partial'
    return payments.some((payment) => payment.status === 'Unpaid') ? 'unpaid' : 'outstanding'
  }
  if (payments.length) return payments.some((payment) => payment.status === 'Partial') ? 'partial' : 'unpaid'
  return enrolled ? 'not-due' : 'not-enrolled'
}

function attendanceText(cell: MonthCell, currentMonth: string) {
  return cell.month <= currentMonth && (cell.scheduled || cell.attended) ? `${cell.attended}/${cell.scheduled}` : ''
}

function money(value: number) {
  return Number(value || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong'
}
