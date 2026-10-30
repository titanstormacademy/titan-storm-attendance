import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { ActionIcon, Alert, Badge, Box, Button, Checkbox, Divider, FileButton, Grid, Group, MultiSelect, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Tabs, Text, TextInput } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { IconAlertCircle, IconCalendarCheck, IconCamera, IconCash, IconMessageCircle, IconPlus, IconSearch, IconTrash, IconUserOff, IconUsers } from '@tabler/icons-react'
import { deleteStudent, recordStudentPayment, removeReceiptIfUnreferenced, removeUploadedImage, saveStudent, saveStudentWithEnrollments, uploadImage } from '../lib/api'
import { getStudentAttendance, type StudentAttendanceEntry } from '../lib/studentOperations'
import { publicImageUrl } from '../lib/supabase'
import { EmptyState, PageHeader, PersonAvatar, PhotoLightbox, ResponsiveModal } from '../components/ui'
import { useNavigationGuard } from '../contexts/useNavigationGuard'
import type { BootstrapData, Payment, PaymentMethod, PaymentStatus, Student } from '../types/models'

const blankStudent: Partial<Student> & { name: string } = {
  name: '', nric: '', gender: '', date_of_birth: null, age: null, height: '', school: '', tshirt_size: '', student_phone: '', parent_name: '', parent_contact: '', email: '', father_height: '', mother_height: '', monthly_fee: null, level: '', status: 'Active',
}
const paymentMethods: PaymentMethod[] = ['Cash', 'Bank Transfer', "Touch 'n Go eWallet", 'Online', 'Others']
type ReportPreset = 'month' | '3months' | '6months' | 'year'

export function StudentsPage({ branchId, data, isAdmin, createRequest = 0, onCreateHandled = () => undefined, onChanged, dialogOnly = false, dialogStudent = null, dialogRequest = 0, onDialogClose }: { branchId: number; data: BootstrapData; isAdmin: boolean; createRequest?: number; onCreateHandled?: () => void; onChanged: () => Promise<unknown>; dialogOnly?: boolean; dialogStudent?: Student | null; dialogRequest?: number; onDialogClose?: () => void }) {
  const [opened, { open, close }] = useDisclosure(false)
  const [paymentOpened, paymentModal] = useDisclosure(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<string>('All')
  const [level, setLevel] = useState<string | null>('All')
  const [classFilter, setClassFilter] = useState<string | null>('All')
  const [form, setForm] = useState(blankStudent)
  const [ageMode, setAgeMode] = useState<'manual' | 'dob'>('manual')
  const [classIds, setClassIds] = useState<string[]>([])
  const [enrollmentDates, setEnrollmentDates] = useState<Record<string, string>>({})
  const [withdrawalDates, setWithdrawalDates] = useState<Record<string, string>>({})
  const [attendance, setAttendance] = useState<StudentAttendanceEntry[]>([])
  const [attendanceLoading, setAttendanceLoading] = useState(false)
  const [attendanceError, setAttendanceError] = useState('')
  const [activeTab, setActiveTab] = useState<string | null>('profile')
  const [reportPreset, setReportPreset] = useState<ReportPreset>('month')
  const [paymentMonths, setPaymentMonths] = useState<string[]>([])
  const [paymentAmount, setPaymentAmount] = useState<number | string>('')
  const [paymentDate, setPaymentDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>('Bank Transfer')
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null)
  const [photoView, setPhotoView] = useState<{ src: string | null; name: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [baseline, setBaseline] = useState('')
  const handledCreateRequest = useRef(0)
  const profileRequest = useRef(0)
  const lastDialogRequest = useRef(0)
  const submitLock = useRef(false)
  const currentSnapshot = studentSnapshot(form, classIds, enrollmentDates, withdrawalDates)
  const dirty = opened && (Boolean(photo) || currentSnapshot !== baseline)
  const { confirmDiscard } = useNavigationGuard('student-editor', { dirty, pending: saving })

  useEffect(() => {
    if (!photo) { setPhotoPreviewUrl(null); return }
    const url = URL.createObjectURL(photo)
    setPhotoPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  useEffect(() => {
    if (!isAdmin || createRequest <= handledCreateRequest.current) return
    handledCreateRequest.current = createRequest
    const nextForm = { ...blankStudent, status: 'Trial' } as Partial<Student> & { name: string }
    setForm(nextForm)
    setAgeMode('manual')
    setClassIds([])
    setEnrollmentDates({})
    setWithdrawalDates({})
    setAttendance([])
    setAttendanceError('')
    setActiveTab('profile')
    setReportPreset('month')
    setPhoto(null)
    setPhotoPreviewUrl(null)
    setBaseline(studentSnapshot(nextForm, [], {}, {}))
    open()
    onCreateHandled()
  }, [createRequest, isAdmin, onCreateHandled, open])

  const filtered = useMemo(() => data.students.filter((student) => {
    const needle = search.toLowerCase()
    const classMatch = classFilter === 'All' || data.enrollments.some((item) => item.student_id === student.id && String(item.class_id) === classFilter && !item.end_date)
    return (!needle || [student.name, student.student_phone, student.parent_contact].some((value) => value?.toLowerCase().includes(needle)))
      && (status === 'All' || student.status === status)
      && (level === 'All' || student.level === level)
      && classMatch
  }).sort((a, b) => a.name.localeCompare(b.name)), [classFilter, data.enrollments, data.students, level, search, status])

  async function showProfile(student?: Student) {
    if (opened && !confirmDiscard({ dirty, pending: saving })) return
    const requestId = ++profileRequest.current
    const next = student || blankStudent
    const nextForm = { ...next, age: next.age ?? null }
    const enrollments = student ? data.enrollments.filter((item) => item.student_id === student.id && !item.end_date) : []
    const nextClassIds = enrollments.map((item) => String(item.class_id))
    const nextDates = Object.fromEntries(enrollments.map((item) => [String(item.class_id), item.start_date]))
    setForm(nextForm)
    setAgeMode(next.date_of_birth ? 'dob' : 'manual')
    setClassIds(nextClassIds)
    setEnrollmentDates(nextDates)
    setWithdrawalDates({})
    setAttendance([])
    setAttendanceError('')
    setAttendanceLoading(Boolean(student))
    setActiveTab(student ? 'summary' : 'profile')
    setReportPreset('month')
    setPhoto(null)
    setPhotoPreviewUrl(null)
    setBaseline(studentSnapshot(nextForm, nextClassIds, nextDates, {}))
    open()
    if (student) {
      try {
        const nextAttendance = await getStudentAttendance(student.id)
        if (requestId === profileRequest.current) setAttendance(nextAttendance)
      } catch (error) {
        if (requestId === profileRequest.current) {
          const message = errorMessage(error)
          setAttendanceError(message)
          notifications.show({ color: 'red', message })
        }
      } finally {
        if (requestId === profileRequest.current) setAttendanceLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!dialogOnly || !dialogStudent || dialogRequest <= lastDialogRequest.current) return
    lastDialogRequest.current = dialogRequest
    const requestId = ++profileRequest.current
    const nextForm = { ...dialogStudent, age: dialogStudent.age ?? null }
    const enrollments = data.enrollments.filter((item) => item.student_id === dialogStudent.id && !item.end_date)
    const nextClassIds = enrollments.map((item) => String(item.class_id))
    const nextDates = Object.fromEntries(enrollments.map((item) => [String(item.class_id), item.start_date]))
    setForm(nextForm)
    setAgeMode(dialogStudent.date_of_birth ? 'dob' : 'manual')
    setClassIds(nextClassIds)
    setEnrollmentDates(nextDates)
    setWithdrawalDates({})
    setAttendance([])
    setAttendanceError('')
    setAttendanceLoading(true)
    setActiveTab('summary')
    setReportPreset('month')
    setPhoto(null)
    setPhotoPreviewUrl(null)
    setBaseline(studentSnapshot(nextForm, nextClassIds, nextDates, {}))
    open()
    getStudentAttendance(dialogStudent.id)
      .then((nextAttendance) => { if (requestId === profileRequest.current) setAttendance(nextAttendance) })
      .catch((error) => { if (requestId === profileRequest.current) { const message = errorMessage(error); setAttendanceError(message); notifications.show({ color: 'red', message }) } })
      .finally(() => { if (requestId === profileRequest.current) setAttendanceLoading(false) })
  }, [data.enrollments, dialogOnly, dialogRequest, dialogStudent, open])

  function finishClose() {
    profileRequest.current += 1
    close()
    onDialogClose?.()
  }

  function guardedClose() {
    if (!confirmDiscard({ dirty, pending: saving })) return
    finishClose()
  }

  function changeAgeMode(value: string) {
    const nextMode = value as 'manual' | 'dob'
    setAgeMode(nextMode)
    setForm((current) => nextMode === 'dob'
      ? { ...current, age: null }
      : { ...current, age: current.date_of_birth ? dayjs().diff(dayjs(current.date_of_birth), 'year') : current.age ?? null, date_of_birth: null })
  }

  function toggleClass(classId: string, checked: boolean) {
    if (checked) {
      setClassIds((current) => current.includes(classId) ? current : [...current, classId])
      setEnrollmentDates((current) => ({ ...current, [classId]: current[classId] || dayjs().format('YYYY-MM-DD') }))
      setWithdrawalDates((current) => { const next = { ...current }; delete next[classId]; return next })
    } else {
      setClassIds((current) => current.filter((id) => id !== classId))
      const activeEnrollment = form.id && data.enrollments.find((item) => item.student_id === form.id && String(item.class_id) === classId && !item.end_date)
      if (activeEnrollment) setWithdrawalDates((current) => ({ ...current, [classId]: dayjs().format('YYYY-MM-DD') }))
    }
  }

  async function submit() {
    if (!isAdmin || submitLock.current) return
    if (!form.name.trim()) {
      notifications.show({ color: 'red', message: 'Student name is required.' })
      return
    }
    if (classIds.some((id) => !enrollmentDates[id])) {
      notifications.show({ color: 'red', message: 'Choose a start date for every selected class.' })
      return
    }
    if (Object.values(withdrawalDates).some((date) => !date)) {
      notifications.show({ color: 'red', message: 'Choose the final enrolled date for every removed class.' })
      return
    }
    submitLock.current = true
    const requestId = profileRequest.current
    const enrollments = classIds.map((id) => ({ class_id: Number(id), start_date: enrollmentDates[id] }))
    const withdrawals = Object.entries(withdrawalDates).map(([id, end_date]) => ({ class_id: Number(id), end_date }))
    let uploadedPhotoPath: string | null = null
    setSaving(true)
    try {
      let payload = form
      if (photo && form.id) {
        uploadedPhotoPath = await uploadImage('student-photos', branchId, photo, form.id)
        payload = { ...form, photo_path: uploadedPhotoPath }
      }
      let saved: Student
      try {
        saved = await saveStudentWithEnrollments(branchId, payload, enrollments, withdrawals)
      } catch (error) {
        if (uploadedPhotoPath) await removeUploadedImage('student-photos', uploadedPhotoPath).catch(() => undefined)
        throw error
      }
      if (uploadedPhotoPath && form.photo_path && form.photo_path !== uploadedPhotoPath) await removeUploadedImage('student-photos', form.photo_path).catch(() => undefined)
      if (photo && !form.id) {
        const photoPath = await uploadImage('student-photos', branchId, photo, saved.id)
        try {
          saved = await saveStudent(branchId, { id: saved.id, name: saved.name, photo_path: photoPath })
        } catch (error) {
          await removeUploadedImage('student-photos', photoPath).catch(() => undefined)
          notifications.show({ color: 'orange', title: 'Student saved without photo', message: errorMessage(error) })
        }
      }
      notifications.show({ color: 'green', title: 'Student saved', message: `${saved.name}'s profile and classes are up to date.` })
      if (requestId === profileRequest.current) {
        setBaseline(studentSnapshot(saved, classIds, enrollmentDates, {}))
        setPhoto(null)
        close()
        onDialogClose?.()
      }
      try { await onChanged() } catch (error) { notifications.show({ color: 'orange', title: 'Student saved, refresh failed', message: errorMessage(error) }) }
    } catch (error) {
      notifications.show({ color: 'red', title: 'Could not save student', message: errorMessage(error) })
    } finally {
      submitLock.current = false
      if (requestId === profileRequest.current) setSaving(false)
    }
  }

  async function remove(student: Student) {
    if (!window.confirm(`Delete ${student.name} and all linked attendance and payment records?`)) return
    try {
      const receiptPaths = [...new Set(data.payments.filter((payment) => payment.student_id === student.id && payment.receipt_path).map((payment) => payment.receipt_path!))]
      await deleteStudent(branchId, student.id)
      if (student.photo_path) await removeUploadedImage('student-photos', student.photo_path).catch(() => undefined)
      await Promise.all(receiptPaths.map((path) => removeReceiptIfUnreferenced(path).catch(() => undefined)))
      notifications.show({ color: 'green', message: 'Student deleted' })
      close()
      onDialogClose?.()
      await onChanged()
    } catch (error) {
      notifications.show({ color: 'red', message: errorMessage(error) })
    }
  }

  const student = form.id ? data.students.find((item) => item.id === form.id) || form as Student : null
  const studentEnrollments = student ? data.enrollments.filter((item) => item.student_id === student.id) : []
  const studentPayments = student ? data.payments.filter((item) => item.student_id === student.id) : []
  const due = student ? calculateDue(student, studentEnrollments, studentPayments) : { months: [], amount: 0 }
  const paymentOptions = paymentMonthOptions(studentEnrollments, studentPayments)
  const period = reportPeriod(reportPreset)
  const reportMonths = monthsBetween(period.start, period.end)
  const reportAttendance = attendance.filter((entry) => entry.attendance_date >= period.start.format('YYYY-MM-DD') && entry.attendance_date <= period.end.format('YYYY-MM-DD'))
  const reportTarget = attendanceTarget(reportMonths, studentEnrollments)
  const reportRemaining = Math.max(0, reportTarget - reportAttendance.length)
  const eligibleReportMonths = reportMonths.filter((month) => isEnrolledInMonth(studentEnrollments, month))
  const paidReportMonths = eligibleReportMonths.filter((month) => paymentStatusForMonth(studentPayments, month.format('YYYY-MM')) === 'Paid').length
  const photoUrl = photoPreviewUrl || (form.photo_path ? publicImageUrl('student-photos', form.photo_path) : null)
  const displayAge = form.date_of_birth ? dayjs().diff(dayjs(form.date_of_birth), 'year') : form.age ?? null

  function openPayment() {
    if (!student) return
    const currentMonth = dayjs().format('YYYY-MM')
    const nextAvailable = paymentOptions.find((option) => option.value === currentMonth)?.value || [...paymentOptions].reverse().find((option) => option.value > currentMonth)?.value
    const initialMonths = due.months.length ? [due.months[0]] : nextAvailable ? [nextAvailable] : []
    setPaymentMonths(initialMonths)
    setPaymentAmount(amountForMonths(student, studentPayments, initialMonths) || '')
    setPaymentDate(dayjs().format('YYYY-MM-DD'))
    setPaymentMethod('Bank Transfer')
    paymentModal.open()
  }

  function updatePaymentMonths(months: string[]) {
    setPaymentMonths(months)
    setPaymentAmount(student ? amountForMonths(student, studentPayments, months) || '' : '')
  }

  async function savePayment() {
    if (!student || !paymentMonths.length || paymentAmount === '' || Number(paymentAmount) <= 0 || !paymentMethod || !paymentDate) return
    setPaymentSaving(true)
    try {
      await recordStudentPayment({ studentId: student.id, feeMonths: paymentMonths, amount: Number(paymentAmount), method: paymentMethod, status: 'Paid', dateReceived: paymentDate, remarks: '', referenceNo: '', coachId: defaultCoach(student.id, data), receiptPath: null })
      notifications.show({ color: 'green', title: 'Payment recorded', message: `${paymentMonths.length} fee month${paymentMonths.length === 1 ? '' : 's'} updated.` })
      paymentModal.close()
      try { await onChanged() } catch (error) { notifications.show({ color: 'orange', title: 'Payment saved, refresh failed', message: errorMessage(error) }) }
    } catch (error) {
      notifications.show({ color: 'red', title: 'Could not record payment', message: errorMessage(error) })
    } finally {
      setPaymentSaving(false)
    }
  }

  return <>
    {!dialogOnly && <>
    <PageHeader title="Students" description="Search, review, and manage student profiles" />
    <Paper className="student-filter-panel" p="md" radius="lg" withBorder mb="sm">
      <Stack gap="sm">
        <TextInput aria-label="Search students" leftSection={<IconSearch size={18} />} placeholder="Search by name or phone…" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        <SegmentedControl className="student-status-filter" fullWidth value={status} onChange={setStatus} data={['All', 'Active', 'Trial', 'Inactive']} />
        <Grid gutter="xs"><Grid.Col span={6}><Select aria-label="Filter students by level" value={level} onChange={setLevel} data={[{ value: 'All', label: 'All Levels' }, 'Beginner', 'Intermediate', 'Advanced']} allowDeselect={false} /></Grid.Col><Grid.Col span={6}><Select aria-label="Filter students by class" value={classFilter} onChange={setClassFilter} data={[{ value: 'All', label: 'All Classes' }, ...data.classes.map((item) => ({ value: String(item.id), label: item.label }))]} allowDeselect={false} /></Grid.Col></Grid>
      </Stack>
    </Paper>
    <Text size="xs" c="dimmed" mb="xs" px={4}>{filtered.length === data.students.length ? `${filtered.length} students` : `${filtered.length} of ${data.students.length} students`}</Text>

    {filtered.length ? <Box className="student-directory-grid">{filtered.map((student) => {
      const enrollmentCount = new Set(data.enrollments.filter((item) => item.student_id === student.id && !item.end_date).map((item) => item.class_id)).size
      const src = publicImageUrl('student-photos', student.photo_path)
      return <Paper key={student.id} component="button" type="button" className="student-directory-card" p="sm" radius="lg" withBorder onClick={() => showProfile(student)}><PersonAvatar name={student.name} src={src} size={68} /><Text className="student-directory-name" fw={700} size="sm" mt="xs" lineClamp={2}>{student.name}</Text><Text size="xs" c="dimmed" mt={3}>{enrollmentCount ? `${enrollmentCount} class${enrollmentCount > 1 ? 'es' : ''}` : 'No class'}</Text><Badge mt="xs" size="sm" variant="light" color={statusColor(student.status)}>{student.status}</Badge></Paper>
    })}</Box> : <EmptyState title="No students found" message="Try changing the filters or add your first student." icon={status === 'Inactive' ? IconUserOff : IconUsers} />}

    {isAdmin && <ActionIcon className="student-fab" aria-label="Add student" size={58} radius="xl" color="orange" onClick={() => showProfile()}><IconPlus size={26} /></ActionIcon>}
    </>}

    <ResponsiveModal classNames={{ inner: 'student-profile-modal-inner', content: 'student-profile-modal-content', body: 'student-profile-modal-body' }} transitionProps={{ transition: 'fade', duration: 0 }} opened={opened} onClose={guardedClose} title={form.id ? form.name : 'Add student'} size="lg" centered closeOnClickOutside={!saving} closeOnEscape={!saving}>
      <Stack>
        <Group wrap="nowrap" className="student-profile-hero">
          <Box className="profile-photo-editor">
            <PersonAvatar name={form.name || 'New student'} src={photoUrl} size={82} onClick={() => setPhotoView({ src: photoUrl, name: form.name || 'Student photo' })} />
            {isAdmin && <FileButton onChange={setPhoto} accept="image/png,image/jpeg,image/webp">{(props) => <ActionIcon {...props} className="profile-camera-button" aria-label="Choose profile photo" color="orange" size={30} radius="xl"><IconCamera size={15} /></ActionIcon>}</FileButton>}
          </Box>
          <Box flex={1} style={{ minWidth: 0 }}><Text fw={800} size="xl" truncate>{form.name || 'New student'}</Text><Text c="dimmed" size="sm">{displayAge != null ? `${displayAge} years old · ` : ''}{form.level || 'No level'}{form.id ? ` · ${attendance.length} attendances` : ''}</Text><Group mt="xs" gap="xs">{form.student_phone && <Button component="a" href={waUrl(form.student_phone)} target="_blank" size="xs" variant="light" color="green" leftSection={<IconMessageCircle size={15} />}>Student WhatsApp</Button>}{form.parent_contact && <Button component="a" href={waUrl(form.parent_contact)} target="_blank" size="xs" variant="light" color="green" leftSection={<IconMessageCircle size={15} />}>Parent WhatsApp</Button>}</Group>{photo && <Text size="xs" c="orange" mt={5}>Photo preview · save to upload</Text>}</Box>
        </Group>

        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List grow>{form.id && <Tabs.Tab value="summary">Summary</Tabs.Tab>}<Tabs.Tab value="profile">Profile</Tabs.Tab></Tabs.List>
          {student && <Tabs.Panel value="summary" pt="md"><Stack gap="lg">
            {attendanceError && <Alert color="red" icon={<IconAlertCircle size={18} />} title="Attendance unavailable">{attendanceError}</Alert>}
            <SimpleGrid cols={{ base: 1, sm: isAdmin ? 2 : 1 }} spacing="sm">
              <Paper className="student-summary-card" p="lg" radius="lg" withBorder><Group justify="space-between" mb="md"><Text fw={800}>Last attendance</Text><IconCalendarCheck size={20} color="#2f9e44" /></Group>{attendanceLoading ? <Text c="dimmed" size="sm">Loading attendance…</Text> : attendance[0] ? <><Text fw={850} size="xl">{dayjs(attendance[0].attendance_date).format('D MMM YYYY')}</Text><Text size="sm" c="dimmed" mt={3}>{attendance[0].class?.label || 'Class'} · {relativeDate(attendance[0].attendance_date)}</Text>{attendance[0].remarks && <Text size="sm" mt="md">{attendance[0].remarks}</Text>}</> : <Text c="dimmed" size="sm">No attendance has been recorded.</Text>}</Paper>
              {isAdmin && <Paper className={`student-summary-card ${due.months.length ? 'payment-due' : ''}`} p="lg" radius="lg" withBorder><Group justify="space-between" mb="md"><Text fw={800}>Payment due</Text><IconCash size={20} color={due.months.length ? '#e8590c' : '#2f9e44'} /></Group>{studentEnrollments.length ? <><Text fw={850} size="xl">RM {money(due.amount)}</Text><Text size="sm" c="dimmed" mt={3}>{due.months.length ? `${due.months.length} unpaid month${due.months.length === 1 ? '' : 's'} · oldest ${dayjs(`${due.months[0]}-01`).format('MMM YYYY')}` : 'No outstanding fee months'}</Text></> : <Text c="dimmed" size="sm">Add a class enrollment to calculate payment due.</Text>}<Button mt="md" variant={due.months.length ? 'filled' : 'light'} leftSection={<IconPlus size={16} />} onClick={openPayment}>{due.months.length ? 'Update payment' : 'Record payment'}</Button></Paper>}
            </SimpleGrid>
            <Box><Group justify="space-between" align="flex-end" mb="sm"><Box><Text fw={850} size="lg">Report summary</Text><Text size="sm" c="dimmed">Attendance{isAdmin ? ' and fee status' : ''} for {period.label.toLowerCase()}.</Text></Box></Group><SegmentedControl className="student-report-period" fullWidth value={reportPreset} onChange={(value) => setReportPreset(value as ReportPreset)} data={[{ value: 'month', label: 'This month' }, { value: '3months', label: '3 months' }, { value: '6months', label: '6 months' }, { value: 'year', label: 'This year' }]} /><Paper className="student-report-overview" p="lg" radius="lg" withBorder mt="sm"><SimpleGrid cols={isAdmin ? 2 : 1}><Box><Text size="xs" c="dimmed" fw={700}>ATTENDANCE</Text><Text fw={850} size="xl">{reportAttendance.length} / {reportTarget}</Text><Text size="xs" c="dimmed">attended · {reportRemaining} session{reportRemaining === 1 ? '' : 's'} below target</Text></Box>{isAdmin && <Box><Text size="xs" c="dimmed" fw={700}>PAYMENT STATUS</Text><Text fw={850} size="xl">{paidReportMonths}/{eligibleReportMonths.length}</Text><Text size="xs" c="dimmed">eligible months paid</Text></Box>}</SimpleGrid></Paper><Stack gap="xs" mt="sm">{[...reportMonths].reverse().map((month) => <MonthlyReportRow key={month.format('YYYY-MM')} month={month} attendance={attendance} payments={studentPayments} enrollments={studentEnrollments} classes={data.classes} showPayments={isAdmin} />)}</Stack></Box>
          </Stack></Tabs.Panel>}
          <Tabs.Panel value="profile" pt="md"><Grid gutter="sm" className="student-profile-form">
            <Grid.Col span={{ base: 12, xs: 8 }}><TextInput label="Full name" value={form.name} disabled={!isAdmin} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 4 }}><Select label="Status" value={form.status} disabled={!isAdmin} onChange={(value) => setForm({ ...form, status: value as Student['status'] })} data={['Active', 'Trial', 'Inactive']} comboboxProps={{ zIndex: 600 }} /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 5 }}><TextInput label="NRIC" value={form.nric || ''} disabled={!isAdmin} onChange={(event) => setForm({ ...form, nric: event.currentTarget.value })} /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 3 }}><Select label="Gender" value={form.gender} disabled={!isAdmin} onChange={(value) => setForm({ ...form, gender: (value || '') as Student['gender'] })} data={['Male', 'Female']} clearable comboboxProps={{ zIndex: 600 }} /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 4 }}><Text size="sm" fw={500} mb={5}>Age entry</Text><SegmentedControl aria-label="Age entry" fullWidth value={ageMode} disabled={!isAdmin} onChange={changeAgeMode} data={[{ value: 'manual', label: 'Manual age' }, { value: 'dob', label: 'DOB' }]} /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 4 }}>{ageMode === 'dob' ? <TextInput label="Date of birth" description={displayAge != null ? `Calculated age: ${displayAge}` : 'Age calculates automatically'} type="date" max={dayjs().format('YYYY-MM-DD')} value={form.date_of_birth || ''} disabled={!isAdmin} onChange={(event) => setForm({ ...form, date_of_birth: event.currentTarget.value || null, age: null })} /> : <NumberInput label="Age" description="Enter age in years" value={form.age ?? ''} disabled={!isAdmin} min={0} max={120} allowDecimal={false} onChange={(value) => setForm({ ...form, age: value === '' ? null : Number(value), date_of_birth: null })} />}</Grid.Col>
            <Grid.Col span={{ base: 12, xs: 4 }}><TextInput label="Student phone" type="tel" value={form.student_phone || ''} disabled={!isAdmin} onChange={(event) => setForm({ ...form, student_phone: event.currentTarget.value })} /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 4 }}><TextInput label="School" value={form.school || ''} disabled={!isAdmin} onChange={(event) => setForm({ ...form, school: event.currentTarget.value })} /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 6 }}><TextInput label="Parent / guardian" value={form.parent_name || ''} disabled={!isAdmin} onChange={(event) => setForm({ ...form, parent_name: event.currentTarget.value })} /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 6 }}><TextInput label="Parent contact" type="tel" value={form.parent_contact || ''} disabled={!isAdmin} onChange={(event) => setForm({ ...form, parent_contact: event.currentTarget.value })} /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 4 }}><Select label="Level" value={form.level} disabled={!isAdmin} onChange={(value) => setForm({ ...form, level: (value || '') as Student['level'] })} data={['Beginner', 'Intermediate', 'Advanced']} clearable comboboxProps={{ zIndex: 600 }} /></Grid.Col>
            <Grid.Col span={{ base: 12, xs: 4 }}><NumberInput label="Monthly fee (RM)" value={form.monthly_fee ?? ''} disabled={!isAdmin} min={0} decimalScale={2} onChange={(value) => setForm({ ...form, monthly_fee: value === '' ? null : Number(value) })} /></Grid.Col>
            <Grid.Col span={{ base: 6, xs: 2 }}><TextInput label="Height" value={form.height || ''} disabled={!isAdmin} onChange={(event) => setForm({ ...form, height: event.currentTarget.value })} /></Grid.Col>
            <Grid.Col span={{ base: 6, xs: 2 }}><TextInput label="T-shirt" value={form.tshirt_size || ''} disabled={!isAdmin} onChange={(event) => setForm({ ...form, tshirt_size: event.currentTarget.value })} /></Grid.Col>
          </Grid><Divider my="lg" /><Stack gap="sm"><Text fw={700}>Class enrollment</Text><Text size="sm" c="dimmed">Select each class and set the date this student started.</Text>{data.classes.length ? data.classes.map((item) => {
            const id = String(item.id); const checked = classIds.includes(id)
            return <Paper key={item.id} className={`student-enrollment-row ${checked ? 'selected' : ''}`} p="md" radius="md" withBorder><Checkbox checked={checked} disabled={!isAdmin || saving} onChange={(event) => toggleClass(id, event.currentTarget.checked)} label={<Box><Text fw={700} size="sm">{item.label}</Text><Text size="xs" c="dimmed">{item.day_of_week} · {item.start_time?.slice(0, 5) || 'Time TBC'}</Text></Box>} />{checked && <TextInput mt="sm" label="Start date" type="date" value={enrollmentDates[id] || ''} disabled={!isAdmin || saving} onChange={(event) => setEnrollmentDates((current) => ({ ...current, [id]: event.currentTarget.value }))} required />}{!checked && withdrawalDates[id] != null && <TextInput mt="sm" label="Final enrolled date" description="Attendance through this date remains part of the enrollment history." type="date" value={withdrawalDates[id]} disabled={!isAdmin || saving} min={enrollmentDates[id]} max={dayjs().format('YYYY-MM-DD')} onChange={(event) => setWithdrawalDates((current) => ({ ...current, [id]: event.currentTarget.value }))} required />}</Paper>
          }) : <Text c="dimmed">No classes are configured for this branch.</Text>}</Stack></Tabs.Panel>
        </Tabs>
        {isAdmin && activeTab === 'profile' ? <Group className="modal-actions" justify="space-between"><Button variant="subtle" color="red" disabled={!form.id || saving} onClick={() => form.id && remove(form as Student)} leftSection={<IconTrash size={16} />}>Delete</Button><Group><Button variant="default" disabled={saving} onClick={guardedClose}>Cancel</Button><Button loading={saving} onClick={submit}>Save student</Button></Group></Group> : <Group className="modal-actions" justify="flex-end"><Button variant="default" onClick={guardedClose}>Close</Button></Group>}
      </Stack>
    </ResponsiveModal>
    <ResponsiveModal opened={paymentOpened} onClose={paymentModal.close} title={`Record payment · ${student?.name || ''}`} size="md" centered closeOnClickOutside={!paymentSaving} closeOnEscape={!paymentSaving}>
      <Stack><MultiSelect label="Fee month(s)" description="Paid months are hidden to prevent duplicate records." required searchable value={paymentMonths} onChange={updatePaymentMonths} data={paymentOptions} comboboxProps={{ zIndex: 700 }} /><Grid><Grid.Col span={{ base: 12, xs: 6 }}><NumberInput label="Total amount received (RM)" value={paymentAmount} onChange={setPaymentAmount} min={0.01} decimalScale={2} required /></Grid.Col><Grid.Col span={{ base: 12, xs: 6 }}><TextInput label="Date received" type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.currentTarget.value)} required /></Grid.Col></Grid><Select label="Payment method" value={paymentMethod} onChange={(value) => setPaymentMethod(value as PaymentMethod)} data={paymentMethods} required comboboxProps={{ zIndex: 700 }} /><Alert color="blue">This records the selected fee months as paid. Receipt, reference, and remarks can still be added later from Payments.</Alert><Group className="modal-actions" justify="flex-end"><Button variant="default" disabled={paymentSaving} onClick={paymentModal.close}>Cancel</Button><Button loading={paymentSaving} disabled={!paymentMonths.length || paymentAmount === '' || Number(paymentAmount) <= 0 || !paymentMethod || !paymentDate} onClick={savePayment}>Save payment</Button></Group></Stack>
    </ResponsiveModal>
    <PhotoLightbox src={photoView?.src || null} name={photoView?.name || 'Student photo'} opened={Boolean(photoView)} onClose={() => setPhotoView(null)} />
  </>
}

function MonthlyReportRow({ month, attendance, payments, enrollments, classes, showPayments }: { month: dayjs.Dayjs; attendance: StudentAttendanceEntry[]; payments: Payment[]; enrollments: BootstrapData['enrollments']; classes: BootstrapData['classes']; showPayments: boolean }) {
  const key = month.format('YYYY-MM')
  const monthAttendance = attendance.filter((entry) => entry.attendance_date.startsWith(key))
  const eligibleClassIds = [...new Set(enrollments.filter((entry) => enrollmentCoversMonth(entry, month)).map((entry) => entry.class_id))]
  const attendedClasses = new Map<number, { label: string; count: number }>()
  monthAttendance.forEach((entry) => {
    if (!entry.class) return
    const current = attendedClasses.get(entry.class.id) || { label: entry.class.label, count: 0 }
    current.count += 1
    attendedClasses.set(entry.class.id, current)
  })
  const classRows = eligibleClassIds.map((classId) => ({ id: classId, label: classes.find((item) => item.id === classId)?.label || 'Class', count: attendedClasses.get(classId)?.count || 0, enrolled: true }))
  attendedClasses.forEach((value, id) => { if (!classRows.some((item) => item.id === id)) classRows.push({ id, label: value.label, count: value.count, enrolled: false }) })
  const paymentStatus = eligibleClassIds.length ? paymentStatusForMonth(payments, key) : null
  const amount = payments.filter((item) => item.fee_month.startsWith(key) && item.status !== 'Unpaid').reduce((sum, item) => sum + Number(item.amount), 0)
  return <Paper className="student-month-row" p="md" radius="md" withBorder><Group justify="space-between" align="flex-start" wrap="nowrap"><Box><Text fw={800}>{month.format('MMMM YYYY')}</Text>{classRows.length ? <Stack gap={2} mt={5}>{classRows.map((item) => <Text key={item.id} size="xs" c="dimmed">{item.label}: <b>{item.count} attended</b>{item.enrolled ? ' · monthly target 4' : ''}</Text>)}</Stack> : <Text size="xs" c="dimmed" mt={4}>Not enrolled</Text>}</Box>{showPayments && (paymentStatus ? <Box ta="right"><Badge variant="light" color={paymentStatusColor(paymentStatus)}>{paymentStatus}</Badge>{amount > 0 && <Text size="xs" c="dimmed" mt={4}>RM {money(amount)}</Text>}</Box> : <Badge variant="light" color="gray">Not enrolled</Badge>)}</Group></Paper>
}

function calculateDue(student: Student, enrollments: BootstrapData['enrollments'], payments: Payment[]) {
  if (!enrollments.length || student.status === 'Inactive') return { months: [], amount: 0 }
  const months = dueMonthsForEnrollments(enrollments).filter((month) => paymentStatusForMonth(payments, month) !== 'Paid')
  return { months, amount: amountForMonths(student, payments, months) }
}

function dueMonthsForEnrollments(enrollments: BootstrapData['enrollments']) {
  const months = new Set<string>()
  const current = dayjs().startOf('month')
  enrollments.forEach((enrollment) => {
    let cursor = dayjs(enrollment.start_date).startOf('month')
    const end = enrollment.end_date ? dayjs(enrollment.end_date).startOf('month') : current
    if (!cursor.isValid() || !end.isValid()) return
    const boundedEnd = end.isAfter(current) ? current : end
    while (cursor.valueOf() <= boundedEnd.valueOf()) {
      months.add(cursor.format('YYYY-MM'))
      cursor = cursor.add(1, 'month')
    }
  })
  return [...months].sort()
}

function amountForMonths(student: Student, payments: Payment[], months: string[]) {
  return months.reduce((sum, month) => {
    const partial = payments.filter((item) => item.fee_month.startsWith(month) && item.status === 'Partial').reduce((total, item) => total + Number(item.amount), 0)
    return sum + Math.max(0, Number(student.monthly_fee || 0) - partial)
  }, 0)
}

function reportPeriod(preset: ReportPreset) {
  const end = dayjs().endOf('month')
  if (preset === '3months') return { start: dayjs().subtract(2, 'month').startOf('month'), end, label: 'Last 3 months' }
  if (preset === '6months') return { start: dayjs().subtract(5, 'month').startOf('month'), end, label: 'Last 6 months' }
  if (preset === 'year') return { start: dayjs().startOf('year'), end, label: 'This year' }
  return { start: dayjs().startOf('month'), end, label: 'This month' }
}

function monthsBetween(start: dayjs.Dayjs, end: dayjs.Dayjs) {
  const result: dayjs.Dayjs[] = []
  let cursor = start.startOf('month')
  const finalMonth = end.startOf('month')
  while (cursor.valueOf() <= finalMonth.valueOf()) {
    result.push(cursor)
    cursor = cursor.add(1, 'month')
  }
  return result
}

function paymentMonthOptions(enrollments: BootstrapData['enrollments'], payments: Payment[]) {
  const starts = enrollments.map((item) => dayjs(item.start_date).startOf('month')).filter((date) => date.isValid())
  const earliest = starts.length ? starts.sort((a, b) => a.valueOf() - b.valueOf())[0] : dayjs().startOf('month')
  return monthsBetween(earliest, dayjs().add(8, 'month')).reverse().filter((month) => paymentStatusForMonth(payments, month.format('YYYY-MM')) !== 'Paid').map((month) => ({ value: month.format('YYYY-MM'), label: month.format('MMMM YYYY') }))
}

function paymentStatusForMonth(payments: Payment[], month: string): PaymentStatus | 'Outstanding' {
  const rows = payments.filter((item) => item.fee_month.startsWith(month))
  if (rows.some((item) => item.status === 'Paid')) return 'Paid'
  if (rows.some((item) => item.status === 'Partial')) return 'Partial'
  return 'Outstanding'
}

function paymentStatusColor(status: PaymentStatus | 'Outstanding') {
  return status === 'Paid' ? 'green' : status === 'Partial' ? 'orange' : 'red'
}

function enrollmentCoversMonth(enrollment: BootstrapData['enrollments'][number], month: dayjs.Dayjs) {
  const start = dayjs(enrollment.start_date).startOf('month')
  const end = enrollment.end_date ? dayjs(enrollment.end_date).startOf('month') : null
  return start.valueOf() <= month.valueOf() && (!end || end.valueOf() >= month.valueOf())
}

function isEnrolledInMonth(enrollments: BootstrapData['enrollments'], month: dayjs.Dayjs) {
  return enrollments.some((enrollment) => enrollmentCoversMonth(enrollment, month))
}

function attendanceTarget(months: dayjs.Dayjs[], enrollments: BootstrapData['enrollments']) {
  return months.reduce((total, month) => total + new Set(enrollments.filter((enrollment) => enrollmentCoversMonth(enrollment, month)).map((enrollment) => enrollment.class_id)).size * 4, 0)
}

function defaultCoach(studentId: number, data: BootstrapData) {
  const enrollment = data.enrollments.find((item) => item.student_id === studentId && !item.end_date)
  return data.classes.find((item) => item.id === enrollment?.class_id)?.coach_id || null
}

function relativeDate(value: string) {
  const days = dayjs().startOf('day').diff(dayjs(value).startOf('day'), 'day')
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

function money(value: number) {
  return Number(value || 0).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

function statusColor(status: Student['status']) {
  return status === 'Active' ? 'green' : status === 'Trial' ? 'orange' : 'gray'
}

function waUrl(phone: string) {
  return `https://wa.me/${phone.replace(/\D/g, '').replace(/^0/, '60')}`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong'
}

function studentSnapshot(form: Partial<Student> & { name: string }, classIds: string[], enrollmentDates: Record<string, string>, withdrawalDates: Record<string, string>) {
  return JSON.stringify({ form, classIds: [...classIds].sort(), enrollmentDates, withdrawalDates })
}
