import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { Alert, Badge, Box, Button, FileInput, Grid, Group, Modal, MultiSelect, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Textarea } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { IconAlertCircle, IconCash, IconCheck, IconEdit, IconEye, IconHistory, IconPlus, IconReceipt, IconRobot, IconSearch, IconTrash, IconUsers } from '@tabler/icons-react'
import { getAttendanceReport, recordStudentPayment, removeReceiptIfUnreferenced, removeUploadedImage, scanReceipt, uploadImage } from '../lib/api'
import { deletePayment, findDuplicateReference, openReceipt, updatePayment } from '../lib/paymentOperations'
import { PageHeader, PersonAvatar, StatCard } from '../components/ui'
import { StudentsPage } from './StudentsPage'
import { publicImageUrl } from '../lib/supabase'
import { useNavigationGuard } from '../contexts/useNavigationGuard'
import type { Attendance, BootstrapData, Payment, PaymentMethod, PaymentStatus, Student } from '../types/models'

const methods: PaymentMethod[] = ['Cash', 'Bank Transfer', "Touch 'n Go eWallet", 'Online', 'Others']
const statuses: PaymentStatus[] = ['Paid', 'Partial', 'Unpaid']

export function PaymentsPage({ branchId, data, onChanged, reportMode = false, onOpenAttendanceGrid }: { branchId: number; data: BootstrapData; onChanged: () => Promise<unknown>; reportMode?: boolean; onOpenAttendanceGrid?: () => void }) {
  const [formOpened, formModal] = useDisclosure(false)
  const [historyOpened, historyModal] = useDisclosure(false)
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null)
  const [studentSearch, setStudentSearch] = useState('')
  const [detailStudent, setDetailStudent] = useState<Student | null>(null)
  const [detailRequest, setDetailRequest] = useState(0)
  const [paymentId, setPaymentId] = useState<number | null>(null)
  const [studentId, setStudentId] = useState<string | null>(null)
  const [feeMonths, setFeeMonths] = useState<string[]>([dayjs().format('YYYY-MM')])
  const [amount, setAmount] = useState<number | string>('')
  const [method, setMethod] = useState<PaymentMethod | null>('Bank Transfer')
  const [status, setStatus] = useState<PaymentStatus | null>('Paid')
  const [dateReceived, setDateReceived] = useState(dayjs().format('YYYY-MM-DD'))
  const [referenceNo, setReferenceNo] = useState('')
  const [coachId, setCoachId] = useState<string | null>(null)
  const [remarks, setRemarks] = useState('')
  const [receipt, setReceipt] = useState<File | null>(null)
  const [receiptPath, setReceiptPath] = useState<string | null>(null)
  const [ocrMessage, setOcrMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [periodMode, setPeriodMode] = useState<'month' | 'year'>('month')
  const [period, setPeriod] = useState(dayjs().format('YYYY-MM'))
  const [year, setYear] = useState(dayjs().format('YYYY'))
  const [attendanceRecords, setAttendanceRecords] = useState<Attendance[]>([])
  const [attendanceLoading, setAttendanceLoading] = useState(false)
  const [attendanceError, setAttendanceError] = useState('')
  const [formBaseline, setFormBaseline] = useState('')
  const ocrRequest = useRef(0)
  const submitLock = useRef(false)
  const formSnapshot = paymentSnapshot({ paymentId, studentId, feeMonths, amount, method, status, dateReceived, referenceNo, coachId, remarks, receiptPath })
  const dirty = formOpened && (Boolean(receipt) || formSnapshot !== formBaseline)
  const paymentValidation = amount === '' || !status ? '' : status === 'Unpaid' && Number(amount) > 0 ? 'Unpaid records must have RM0 received.' : status !== 'Unpaid' && Number(amount) <= 0 ? `${status} records require an amount greater than RM0.` : ''
  const { confirmDiscard } = useNavigationGuard('payment-editor', { dirty, pending: saving })
  const reportStart = (periodMode === 'month' ? dayjs(`${period}-01`).startOf('month') : dayjs(`${year}-01-01`).startOf('year')).format('YYYY-MM-DD')
  const reportEnd = (periodMode === 'month' ? dayjs(`${period}-01`).endOf('month') : dayjs(`${year}-01-01`).endOf('year')).format('YYYY-MM-DD')

  useEffect(() => {
    if (!reportMode) return
    let active = true
    setAttendanceLoading(true)
    setAttendanceError('')
    getAttendanceReport(branchId, reportStart, reportEnd)
      .then((records) => { if (active) setAttendanceRecords(records.filter((record) => !record.is_trial)) })
      .catch((error) => { if (active) setAttendanceError(error instanceof Error ? error.message : 'Could not load attendance') })
      .finally(() => { if (active) setAttendanceLoading(false) })
    return () => { active = false }
  }, [branchId, reportEnd, reportMode, reportStart])

  const periodPayments = data.payments.filter((payment) => periodMode === 'month' ? payment.fee_month.startsWith(period) : payment.fee_month.startsWith(year))
  const collected = periodPayments.filter((payment) => payment.status !== 'Unpaid').reduce((sum, payment) => sum + Number(payment.amount), 0)
  const enrolledIds = new Set(data.enrollments.filter((item) => !item.end_date).map((item) => item.student_id))
  const activeEnrolled = data.students.filter((student) => student.status === 'Active' && enrolledIds.has(student.id))
  const reportStudents = data.students.filter((student) => student.status === 'Active' && data.enrollments.some((enrollment) => enrollment.student_id === student.id && enrollment.start_date <= reportEnd && (!enrollment.end_date || enrollment.end_date >= reportStart)))
  const listedStudents = reportMode ? reportStudents : activeEnrolled
  const reportMonths = monthsBetween(dayjs(reportStart), dayjs(reportEnd))
  const attendanceByStudent = new Map(listedStudents.map((student) => {
    const attended = attendanceRecords.filter((record) => record.student_id === student.id).length
    const target = attendanceTargetForStudent(student.id, reportMonths, data)
    return [student.id, { attended, target }]
  }))
  const studentsAttended = listedStudents.filter((student) => (attendanceByStudent.get(student.id)?.attended || 0) > 0).length
  const studentsMeetingTarget = listedStudents.filter((student) => { const summary = attendanceByStudent.get(student.id); return Boolean(summary?.target && summary.attended >= summary.target) }).length
  const searchNeedle = studentSearch.trim().toLowerCase()
  const visibleStudents = listedStudents.filter((student) => !searchNeedle || student.name.toLowerCase().includes(searchNeedle))
  const paidIds = new Set(listedStudents.filter((student) => isStudentSettledForPeriod(data, student, periodMode, period, year)).map((student) => student.id))
  const arrears = useMemo(() => calculateArrears(data), [data])
  const outstandingStudents = listedStudents.filter((student) => (arrears.get(student.id)?.months.length || 0) > 0)
  const outstandingAmount = outstandingStudents.reduce((sum, student) => sum + (arrears.get(student.id)?.amount || 0), 0)
  const months = useMemo(() => {
    const starts = data.enrollments.map((item) => dayjs(item.start_date).startOf('month')).filter((date) => date.isValid())
    const earliest = starts.length ? starts.sort((a, b) => a.valueOf() - b.valueOf())[0] : dayjs().subtract(15, 'month').startOf('month')
    const latest = dayjs().add(8, 'month').startOf('month')
    const count = Math.min(180, latest.diff(earliest, 'month') + 1)
    return Array.from({ length: Math.max(1, count) }, (_, index) => earliest.add(index, 'month')).map((date) => ({ value: date.format('YYYY-MM'), label: date.format('MMMM YYYY') })).reverse()
  }, [data.enrollments])
  const years = Array.from({ length: 6 }, (_, index) => String(dayjs().year() - index))
  const history = selectedStudent ? data.payments.filter((payment) => payment.student_id === selectedStudent.id).sort((a, b) => b.fee_month.localeCompare(a.fee_month) || b.id - a.id) : []

  function defaultCoach(nextStudentId: number) {
    const enrollment = data.enrollments.find((item) => item.student_id === nextStudentId && !item.end_date)
    return data.classes.find((item) => item.id === enrollment?.class_id)?.coach_id || null
  }

  function resetForm(nextStudent?: Student) {
    const next = { paymentId: null, studentId: nextStudent ? String(nextStudent.id) : null, feeMonths: [dayjs().format('YYYY-MM')], amount: nextStudent?.monthly_fee ?? '', method: 'Bank Transfer' as PaymentMethod, status: 'Paid' as PaymentStatus, dateReceived: dayjs().format('YYYY-MM-DD'), referenceNo: '', coachId: nextStudent ? String(defaultCoach(nextStudent.id) || '') || null : null, remarks: '', receiptPath: null }
    setPaymentId(next.paymentId); setStudentId(next.studentId); setFeeMonths(next.feeMonths); setAmount(next.amount); setCoachId(next.coachId); setMethod(next.method); setStatus(next.status); setDateReceived(next.dateReceived); setReferenceNo(next.referenceNo); setRemarks(next.remarks); setReceipt(null); setReceiptPath(next.receiptPath); setOcrMessage('')
    setFormBaseline(paymentSnapshot(next))
  }

  function openNew(student?: Student) {
    resetForm(student)
    formModal.open()
  }

  function editPayment(payment: Payment) {
    const next = { paymentId: payment.id, studentId: String(payment.student_id), feeMonths: [payment.fee_month.slice(0, 7)], amount: Number(payment.amount), method: payment.method || 'Others', status: payment.status, dateReceived: payment.date_received || dayjs().format('YYYY-MM-DD'), referenceNo: payment.reference_no || '', coachId: payment.coach_id ? String(payment.coach_id) : null, remarks: payment.remarks || '', receiptPath: payment.receipt_path }
    setPaymentId(next.paymentId); setStudentId(next.studentId); setFeeMonths(next.feeMonths); setAmount(next.amount); setMethod(next.method); setStatus(next.status); setDateReceived(next.dateReceived); setReferenceNo(next.referenceNo); setCoachId(next.coachId); setRemarks(next.remarks); setReceipt(null); setReceiptPath(next.receiptPath); setOcrMessage(''); setFormBaseline(paymentSnapshot(next))
    formModal.open()
  }

  function closeForm() {
    if (!confirmDiscard({ dirty, pending: saving })) return
    ocrRequest.current += 1
    formModal.close()
  }

  function showHistory(student: Student) {
    setSelectedStudent(student)
    historyModal.open()
  }

  function showStudent(student: Student) {
    setDetailStudent(student)
    setDetailRequest((current) => current + 1)
  }

  async function handleReceipt(file: File | null) {
    const requestId = ++ocrRequest.current
    setReceipt(file); setOcrMessage('')
    if (!file) return
    setSaving(true)
    try {
      const result = await scanReceipt(file)
      if (requestId !== ocrRequest.current) return
      if (result.amount != null) setAmount(result.amount)
      if (result.date && /^\d{4}-\d{2}-\d{2}$/.test(result.date)) setDateReceived(result.date)
      if (result.method) setMethod(result.method)
      if (result.reference) setReferenceNo(result.reference)
      setOcrMessage(result.confidence != null ? `Receipt read with ${Math.round(result.confidence * 100)}% confidence. Verify every field before saving.` : 'Receipt read. Verify every field before saving.')
    } catch (error) {
      if (requestId === ocrRequest.current) setOcrMessage(`OCR unavailable: ${errorMessage(error)}. Enter the details manually.`)
    } finally {
      if (requestId === ocrRequest.current) setSaving(false)
    }
  }

  async function submit() {
    if (!studentId || !feeMonths.length || amount === '' || !method || !status || !dateReceived || submitLock.current) return
    if (paymentValidation) { notifications.show({ color: 'red', message: paymentValidation }); return }
    submitLock.current = true
    let uploadedReceiptPath: string | null = null
    let committed = false
    const oldReceiptPath = paymentId ? data.payments.find((payment) => payment.id === paymentId)?.receipt_path || null : null
    setSaving(true)
    try {
      const duplicate = await findDuplicateReference(branchId, referenceNo, paymentId || undefined)
      if (duplicate && !window.confirm(`Reference already exists for ${duplicate.student?.name || 'another student'} (${dayjs(duplicate.fee_month).format('MMM YYYY')}). Save anyway?`)) return
      const nextReceiptPath = receipt ? await uploadImage('payment-receipts', branchId, receipt, Number(studentId)) : receiptPath
      if (receipt) uploadedReceiptPath = nextReceiptPath
      if (paymentId) {
        await updatePayment(branchId, paymentId, { student_id: Number(studentId), fee_month: feeMonths[0], amount: Number(amount), method, status, date_received: dateReceived, remarks, reference_no: referenceNo, coach_id: coachId ? Number(coachId) : null, receipt_path: nextReceiptPath })
      } else {
        await recordStudentPayment({ studentId: Number(studentId), feeMonths, amount: Number(amount), method, status, dateReceived, remarks, referenceNo, coachId: coachId ? Number(coachId) : null, receiptPath: nextReceiptPath })
      }
      committed = true
      if (oldReceiptPath && oldReceiptPath !== nextReceiptPath) await removeReceiptIfUnreferenced(oldReceiptPath).catch(() => undefined)
      notifications.show({ color: 'green', title: paymentId ? 'Payment updated' : 'Payment recorded', message: paymentId ? 'The payment correction was saved.' : `${feeMonths.length} fee month${feeMonths.length > 1 ? 's' : ''} updated.` })
      setFormBaseline(paymentSnapshot({ paymentId, studentId, feeMonths, amount, method, status, dateReceived, referenceNo, coachId, remarks, receiptPath: nextReceiptPath }))
      setReceipt(null)
      formModal.close()
      try { await onChanged() } catch (error) { notifications.show({ color: 'orange', title: 'Payment saved, refresh failed', message: errorMessage(error) }) }
    } catch (error) {
      if (!committed && uploadedReceiptPath) await removeUploadedImage('payment-receipts', uploadedReceiptPath).catch(() => undefined)
      notifications.show({ color: 'red', title: 'Could not save payment', message: errorMessage(error) })
    } finally {
      submitLock.current = false
      setSaving(false)
    }
  }

  async function viewReceipt(path: string) {
    try { await openReceipt(path) }
    catch (error) { notifications.show({ color: 'red', title: 'Could not open receipt', message: errorMessage(error) }) }
  }

  async function remove(payment: Payment) {
    if (!window.confirm(`Delete the ${dayjs(payment.fee_month).format('MMMM YYYY')} payment?`)) return
    try {
      await deletePayment(branchId, payment)
      if (payment.receipt_path) await removeReceiptIfUnreferenced(payment.receipt_path).catch(() => undefined)
      notifications.show({ color: 'green', message: 'Payment deleted' })
      await onChanged()
    } catch (error) {
      notifications.show({ color: 'red', title: 'Payment cannot be deleted', message: errorMessage(error) })
    }
  }

  return (
    <>
      <PageHeader title={reportMode ? 'Reports' : 'Payments'} description={reportMode ? 'Branch attendance, fee collection, and student status in one view' : 'Student fees, receipts, payment history, and outstanding months'} action={<Group><SegmentedControl value={periodMode} onChange={(value) => setPeriodMode(value as 'month' | 'year')} data={[{ value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }]} />{periodMode === 'month' ? <Select value={period} onChange={(value) => setPeriod(value || dayjs().format('YYYY-MM'))} data={months} w={180} /> : <Select value={year} onChange={(value) => setYear(value || dayjs().format('YYYY'))} data={years} w={120} />}<Button leftSection={<IconPlus size={17} />} onClick={() => openNew()}>Record payment</Button></Group>} />
      {reportMode && <SegmentedControl value="overview" onChange={(value) => { if (value === 'attendance') onOpenAttendanceGrid?.() }} data={[{ value: 'overview', label: 'Overview' }, { value: 'attendance', label: 'Attendance grid' }]} mb="md" />}
      {attendanceError && <Alert color="red" title="Attendance overview unavailable" mb="md">{attendanceError}</Alert>}
      <SimpleGrid cols={{ base: 1, xs: 2, lg: reportMode ? 5 : 3 }} mb="xl">
        {reportMode && <StatCard label="Students attended" value={attendanceLoading ? '…' : `${studentsAttended} / ${listedStudents.length}`} detail="Attended at least once" icon={IconUsers} color="violet" />}
        {reportMode && <StatCard label="Meeting target" value={attendanceLoading ? '…' : `${studentsMeetingTarget} / ${listedStudents.length}`} detail="Four sessions per class monthly" icon={IconCheck} color="teal" />}
        <StatCard label="Fully paid" value={reportMode ? `${paidIds.size} / ${listedStudents.length}` : paidIds.size} detail={reportMode ? (periodMode === 'month' ? dayjs(`${period}-01`).format('MMMM YYYY') : year) : `${activeEnrolled.length} active enrolled students`} icon={IconCheck} color="blue" />
        <StatCard label="Applied to fees" value={`RM ${money(collected)}`} detail={periodMode === 'month' ? dayjs(`${period}-01`).format('MMMM YYYY') : year} icon={IconCash} color="green" />
        <StatCard label="All-time outstanding" value={`RM ${money(outstandingAmount)}`} detail={`${outstandingStudents.length} students · from enrollment start`} icon={IconAlertCircle} color="red" />
      </SimpleGrid>

      <Paper radius="lg" withBorder>
        <Box p="lg"><Group justify="space-between"><Box><Text fw={800} size="lg">{reportMode ? 'Student breakdown' : 'Student collection status'}</Text><Text c="dimmed" size="sm">{reportMode ? 'Compare each student’s attendance and payment status.' : 'Open a student to review or correct every payment.'}</Text></Box><Badge variant="light" size="lg">{periodMode === 'month' ? dayjs(`${period}-01`).format('MMM YYYY') : year}</Badge></Group><TextInput mt="md" aria-label="Search payment students by name" leftSection={<IconSearch size={17} />} placeholder="Search student name…" value={studentSearch} onChange={(event) => setStudentSearch(event.currentTarget.value)} /><Text size="xs" c="dimmed" mt={6}>{visibleStudents.length === listedStudents.length ? `${listedStudents.length} student${listedStudents.length === 1 ? '' : 's'}` : `${visibleStudents.length} of ${listedStudents.length} students`}</Text></Box>
        {!visibleStudents.length && <Text c="dimmed" ta="center" py="xl">No students match this name.</Text>}
        <Stack hiddenFrom="md" p="md" gap="sm">{visibleStudents.map((student) => <PaymentCard key={student.id} student={student} payments={periodPayments.filter((payment) => payment.student_id === student.id)} arrears={arrears.get(student.id)} attendance={reportMode ? attendanceByStudent.get(student.id) : undefined} status={reportMode ? paymentStatusForPeriod(data, student, periodMode, period, year) : undefined} onOpen={() => showStudent(student)} onHistory={() => showHistory(student)} onAdd={() => openNew(student)} />)}</Stack>
        <Box visibleFrom="md"><Table.ScrollContainer minWidth={820}><Table verticalSpacing="sm" horizontalSpacing="lg" highlightOnHover><Table.Thead><Table.Tr><Table.Th>Student</Table.Th>{reportMode && <Table.Th>Attendance</Table.Th>}<Table.Th>Monthly fee</Table.Th><Table.Th>Status</Table.Th><Table.Th>Received</Table.Th><Table.Th>Method / reference</Table.Th><Table.Th>Outstanding</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>{visibleStudents.map((student) => {
          const rows = periodPayments.filter((payment) => payment.student_id === student.id); const best = bestPayment(rows); const periodStatus = reportMode ? paymentStatusForPeriod(data, student, periodMode, period, year) : best?.status; const total = rows.filter((payment) => payment.status !== 'Unpaid').reduce((sum, payment) => sum + Number(payment.amount), 0); const due = arrears.get(student.id)
          return <Table.Tr key={student.id} className="payment-student-row" tabIndex={0} onClick={() => showStudent(student)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); showStudent(student) } }}><Table.Td><Group wrap="nowrap"><PersonAvatar name={student.name} src={publicImageUrl('student-photos', student.photo_path)} size={42} /><Box><Text fw={700}>{student.name}</Text><Text size="xs" c="dimmed">{student.student_phone || student.parent_contact || 'No phone'}</Text></Box></Group></Table.Td>{reportMode && <Table.Td><AttendanceValue summary={attendanceByStudent.get(student.id)} loading={attendanceLoading} /></Table.Td>}<Table.Td>RM {money(student.monthly_fee || 0)}</Table.Td><Table.Td><StatusBadge status={periodStatus} /></Table.Td><Table.Td><Text fw={650}>RM {money(total)}</Text><Text size="xs" c="dimmed">{best?.date_received ? dayjs(best.date_received).format('D MMM YYYY') : '—'}</Text></Table.Td><Table.Td><Text size="sm">{best?.method || '—'}</Text><Text size="xs" c="dimmed">{best?.reference_no || 'No reference'}</Text></Table.Td><Table.Td><Text fw={650}>{due?.months.length || 0} months</Text><Text size="xs" c="dimmed">RM {money(due?.amount || 0)}</Text></Table.Td><Table.Td><Group gap="xs" wrap="nowrap"><Button variant="subtle" size="xs" onClick={(event) => { event.stopPropagation(); showHistory(student) }}>History</Button><Button variant="light" size="xs" onClick={(event) => { event.stopPropagation(); openNew(student) }}>Add</Button></Group></Table.Td></Table.Tr>
        })}</Table.Tbody></Table></Table.ScrollContainer></Box>
      </Paper>

      <Modal opened={historyOpened} onClose={historyModal.close} title={`${selectedStudent?.name || ''} payment history`} size="lg" centered>
        <Stack>{history.length ? history.map((payment) => <Paper key={payment.id} p="md" radius="md" withBorder><Group justify="space-between" align="flex-start"><Box><Group gap="xs"><Text fw={800}>{dayjs(payment.fee_month).format('MMMM YYYY')}</Text><StatusBadge status={payment.status} />{payment.commission_settled && <Badge color="violet" variant="light">Commission settled</Badge>}</Group><Text size="sm" c="dimmed" mt={4}>{payment.method || 'No method'} · {payment.date_received ? dayjs(payment.date_received).format('D MMM YYYY') : 'No received date'}</Text></Box><Text fw={850}>RM {money(payment.amount)}</Text></Group><Text size="sm" mt="sm">Reference: {payment.reference_no || '—'}</Text>{payment.remarks && <Text size="sm" c="dimmed">{payment.remarks}</Text>}<Group mt="md"><Button variant="light" leftSection={<IconEdit size={16} />} onClick={() => editPayment(payment)}>Edit</Button>{payment.receipt_path && <Button variant="light" color="blue" leftSection={<IconEye size={16} />} onClick={() => viewReceipt(payment.receipt_path!)}>Receipt</Button>}<Button variant="light" color="red" leftSection={<IconTrash size={16} />} onClick={() => remove(payment)}>Delete</Button></Group></Paper>) : <Text c="dimmed" ta="center" py="xl">No payments recorded.</Text>}<Button leftSection={<IconPlus size={16} />} onClick={() => selectedStudent && openNew(selectedStudent)}>Add payment</Button></Stack>
      </Modal>

      <Modal opened={formOpened} onClose={closeForm} title={paymentId ? 'Edit payment' : 'Record student payment'} size="lg" centered>
        <Stack>
          <Select label="Student" searchable required value={studentId} onChange={(value) => { setStudentId(value); const student = data.students.find((item) => String(item.id) === value); setAmount(student?.monthly_fee || ''); setCoachId(student ? String(defaultCoach(student.id) || '') || null : null) }} data={activeEnrolled.map((student) => ({ value: String(student.id), label: student.name }))} />
          {paymentId ? <Select label="Fee month" value={feeMonths[0]} onChange={(value) => setFeeMonths(value ? [value] : [])} data={months} /> : <MultiSelect label="Fee month(s)" required value={feeMonths} onChange={setFeeMonths} data={months} searchable />}
          <Grid><Grid.Col span={{ base: 12, xs: 6 }}><NumberInput label="Amount received (RM)" value={amount} onChange={setAmount} min={0} decimalScale={2} required /></Grid.Col><Grid.Col span={{ base: 12, xs: 6 }}><TextInput label="Date received" type="date" value={dateReceived} onChange={(event) => setDateReceived(event.currentTarget.value)} required /></Grid.Col></Grid>
          <Grid><Grid.Col span={{ base: 12, xs: 6 }}><Select label="Method" value={method} onChange={(value) => setMethod(value as PaymentMethod)} data={methods} required /></Grid.Col><Grid.Col span={{ base: 12, xs: 6 }}><Select label="Status" value={status} onChange={(value) => setStatus(value as PaymentStatus)} data={statuses} required /></Grid.Col></Grid>
          <Grid><Grid.Col span={{ base: 12, xs: 6 }}><TextInput label="Reference number" value={referenceNo} onChange={(event) => setReferenceNo(event.currentTarget.value)} /></Grid.Col><Grid.Col span={{ base: 12, xs: 6 }}><Select label="Coach for commission" clearable value={coachId} onChange={setCoachId} data={data.coaches.filter((coach) => coach.coach_type === 'Head').map((coach) => ({ value: String(coach.id), label: coach.name }))} /></Grid.Col></Grid>
          <Textarea label="Remarks" description="Include registration fees or adjustments here." value={remarks} onChange={(event) => setRemarks(event.currentTarget.value)} />
          <FileInput label="Receipt" accept="image/png,image/jpeg,image/webp" value={receipt} onChange={handleReceipt} leftSection={<IconReceipt size={16} />} clearable />
          {receiptPath && !receipt && <Button variant="light" leftSection={<IconEye size={16} />} onClick={() => viewReceipt(receiptPath)}>View current receipt</Button>}
          {ocrMessage && <Alert icon={<IconRobot size={17} />} color={ocrMessage.startsWith('OCR unavailable') ? 'orange' : 'blue'}>{ocrMessage}</Alert>}
          {paymentValidation && <Alert color="red">{paymentValidation}</Alert>}
          {!paymentId && feeMonths.length > 1 && <Alert color="blue">The latest month stores the full amount and reference. Earlier months are recorded separately with the selected {status || 'payment'} status.</Alert>}
          {paymentId && data.payments.find((payment) => payment.id === paymentId)?.commission_settled && <Alert color="violet">This payment is linked to a settled coach payout. Editing it does not recalculate historical payout lines.</Alert>}
          <Group className="modal-actions" justify="flex-end"><Button variant="default" disabled={saving} onClick={closeForm}>Cancel</Button><Button onClick={submit} loading={saving} disabled={!studentId || !feeMonths.length || amount === '' || Boolean(paymentValidation)}>Save payment</Button></Group>
        </Stack>
      </Modal>
      <StudentsPage branchId={branchId} data={data} isAdmin dialogOnly dialogStudent={detailStudent} dialogRequest={detailRequest} onDialogClose={() => setDetailStudent(null)} onChanged={onChanged} />
    </>
  )
}

function PaymentCard({ student, payments, arrears, attendance, status, onOpen, onHistory, onAdd }: { student: Student; payments: Payment[]; arrears?: { months: string[]; amount: number }; attendance?: { attended: number; target: number }; status?: PaymentStatus; onOpen: () => void; onHistory: () => void; onAdd: () => void }) {
  const best = bestPayment(payments); const total = payments.filter((payment) => payment.status !== 'Unpaid').reduce((sum, payment) => sum + Number(payment.amount), 0)
  return <Paper className="payment-student-card" role="button" tabIndex={0} p="md" radius="md" withBorder onClick={onOpen} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen() } }}><Group justify="space-between" align="flex-start" wrap="nowrap"><Group wrap="nowrap" style={{ minWidth: 0 }}><PersonAvatar name={student.name} src={publicImageUrl('student-photos', student.photo_path)} size={48} /><Box style={{ minWidth: 0 }}><Text fw={800} truncate>{student.name}</Text><Text size="xs" c="dimmed" truncate>{student.student_phone || student.parent_contact || 'No phone'}</Text><Text size="xs" c="dimmed">RM {money(student.monthly_fee || 0)} / month</Text></Box></Group><StatusBadge status={status || best?.status} /></Group><SimpleGrid cols={attendance ? 3 : 2} mt="md">{attendance && <Box><Text size="xs" c="dimmed">Attendance</Text><AttendanceValue summary={attendance} /></Box>}<Box><Text size="xs" c="dimmed">Received</Text><Text fw={700}>RM {money(total)}</Text></Box><Box><Text size="xs" c="dimmed">Outstanding</Text><Text fw={700}>{arrears?.months.length || 0} months</Text><Text size="xs" c="dimmed">RM {money(arrears?.amount || 0)}</Text></Box></SimpleGrid><Group grow mt="md"><Button variant="light" leftSection={<IconHistory size={16} />} onClick={(event) => { event.stopPropagation(); onHistory() }}>History</Button><Button leftSection={<IconPlus size={16} />} onClick={(event) => { event.stopPropagation(); onAdd() }}>Add</Button></Group></Paper>
}

function AttendanceValue({ summary, loading = false }: { summary?: { attended: number; target: number }; loading?: boolean }) {
  if (loading) return <Text fw={700}>…</Text>
  const attended = summary?.attended || 0
  const target = summary?.target || 0
  const remaining = Math.max(0, target - attended)
  return <><Text fw={700}>{attended} / {target}</Text><Text size="xs" c="dimmed">{remaining} below target</Text></>
}

function StatusBadge({ status }: { status?: PaymentStatus }) {
  return <Badge color={status === 'Paid' ? 'green' : status === 'Partial' ? 'orange' : 'red'} variant="light">{status || 'Outstanding'}</Badge>
}

function bestPayment(rows: Payment[]) {
  return rows.find((payment) => payment.status === 'Paid') || rows.find((payment) => payment.status === 'Partial') || rows[0]
}

function monthsBetween(start: dayjs.Dayjs, end: dayjs.Dayjs) {
  const months: dayjs.Dayjs[] = []
  let cursor = start.startOf('month')
  const last = end.startOf('month')
  while (cursor.valueOf() <= last.valueOf()) {
    months.push(cursor)
    cursor = cursor.add(1, 'month')
  }
  return months
}

function attendanceTargetForStudent(studentId: number, months: dayjs.Dayjs[], data: BootstrapData) {
  return months.reduce((total, month) => {
    const classIds = new Set(data.enrollments.filter((enrollment) => enrollment.student_id === studentId && dayjs(enrollment.start_date).startOf('month').valueOf() <= month.valueOf() && (!enrollment.end_date || dayjs(enrollment.end_date).startOf('month').valueOf() >= month.valueOf())).map((enrollment) => enrollment.class_id))
    return total + classIds.size * 4
  }, 0)
}

function dueMonthsForStudent(data: BootstrapData, studentId: number) {
  const due = new Set<string>()
  const current = dayjs().startOf('month')
  data.enrollments.filter((item) => item.student_id === studentId).forEach((period) => {
    let cursor = dayjs(period.start_date).startOf('month')
    const end = period.end_date ? dayjs(period.end_date).startOf('month') : current
    if (!cursor.isValid() || !end.isValid()) return
    const boundedEnd = end.isAfter(current) ? current : end
    while (cursor.isBefore(boundedEnd) || cursor.isSame(boundedEnd, 'month')) {
      due.add(cursor.format('YYYY-MM'))
      cursor = cursor.add(1, 'month')
    }
  })
  return [...due].sort()
}

function monthOutstanding(data: BootstrapData, student: Student, month: string) {
  const rows = data.payments.filter((payment) => payment.student_id === student.id && payment.fee_month.startsWith(month))
  if (rows.some((payment) => payment.status === 'Paid')) return 0
  const received = rows.filter((payment) => payment.status === 'Partial').reduce((sum, payment) => sum + Number(payment.amount), 0)
  return Math.max(0, Number(student.monthly_fee || 0) - received)
}

function isStudentSettledForPeriod(data: BootstrapData, student: Student, mode: 'month' | 'year', period: string, year: string) {
  const due = dueMonthsForStudent(data, student.id).filter((month) => mode === 'month' ? month === period : month.startsWith(year))
  return due.length > 0 && due.every((month) => monthOutstanding(data, student, month) === 0)
}

function paymentStatusForPeriod(data: BootstrapData, student: Student, mode: 'month' | 'year', period: string, year: string): PaymentStatus | undefined {
  const due = dueMonthsForStudent(data, student.id).filter((month) => mode === 'month' ? month === period : month.startsWith(year))
  if (due.length && due.every((month) => monthOutstanding(data, student, month) === 0)) return 'Paid'
  const payments = data.payments.filter((payment) => payment.student_id === student.id && (mode === 'month' ? payment.fee_month.startsWith(period) : payment.fee_month.startsWith(year)))
  return payments.some((payment) => payment.status !== 'Unpaid' && Number(payment.amount) > 0) ? 'Partial' : undefined
}

function calculateArrears(data: BootstrapData) {
  const result = new Map<number, { months: string[]; amount: number }>()
  data.students.forEach((student) => {
    const balances = dueMonthsForStudent(data, student.id).map((month) => ({ month, amount: monthOutstanding(data, student, month) })).filter((item) => item.amount > 0)
    result.set(student.id, { months: balances.map((item) => item.month), amount: balances.reduce((sum, item) => sum + item.amount, 0) })
  })
  return result
}

function money(value: number) {
  return Number(value).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong'
}

function paymentSnapshot(value: {
  paymentId: number | null
  studentId: string | null
  feeMonths: string[]
  amount: number | string
  method: PaymentMethod | null
  status: PaymentStatus | null
  dateReceived: string
  referenceNo: string
  coachId: string | null
  remarks: string
  receiptPath: string | null
}) {
  return JSON.stringify(value)
}
