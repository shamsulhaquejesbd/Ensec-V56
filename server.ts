import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_ALLOWED_RADIUS_METERS,
  DEFAULT_GRACE_PERIOD_MINUTES,
  DEFAULT_MAX_GPS_ACCURACY_METERS,
  DEFAULT_OFFICE_LOCATIONS,
  DEFAULT_SHIFT_START_TIME,
  calculateShiftAttendanceStatus,
  evaluateGeofenceAttendance,
  isValidCoordinatePair,
} from './src/lib/geofence.ts';
import type {
  AttendanceRecord,
  OfficeLocation,
  RejectedAttendanceAttempt,
} from './src/types/payroll.ts';
import {
  authorizeCostSheetForUser,
  resolveManufacturingCostPermissions,
  sanitizeMaterialIssueContextForUser,
  sanitizeMaterialIssueRecordForUser,
  sanitizeProductionOrderForUser,
} from './src/lib/manufacturingPermissions.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Supabase server client (optional, falls back gracefully if tables not yet migrated)
const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  'https://ykljdwdkgysnekiqqaby.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_-ij_EEVGDNaAD834Nac1Iw_4nq2Iafr';

let serverSupabase: SupabaseClient | null = null;
try {
  if (SUPABASE_URL && SUPABASE_KEY) {
    serverSupabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
} catch {
  serverSupabase = null;
}

// Authoritative server-side stores (hydrated from Supabase if available + synced from client)
const officeLocationsStore = new Map<string, OfficeLocation>(
  DEFAULT_OFFICE_LOCATIONS.map((loc) => [loc.id, loc])
);
const attendanceRecordsStore = new Map<string, AttendanceRecord>(); // key: `${employeeId}_${date}`
const rejectedAttemptsStore: RejectedAttendanceAttempt[] = [];
const lastEmployeeGpsPing = new Map<
  string,
  { latitude: number; longitude: number; timestampMs: number }
>();

interface ResolvedOfficeConfig {
  assignedOfficeId: string;
  assignedOfficeName: string;
  officeAddress: string;
  officeLatitude: number;
  officeLongitude: number;
  allowedRadiusMeters: number;
  locationStatus: 'Active' | 'Inactive';
}

async function resolveOfficeForEmployee(body: any): Promise<ResolvedOfficeConfig> {
  // 1. Prefer server-stored office if assignedOfficeId exists
  const officeId = String(body.assignedOfficeId || body.officeId || '').trim();
  let storedOffice = officeId ? officeLocationsStore.get(officeId) : undefined;

  if (!storedOffice && serverSupabase && officeId) {
    try {
      const { data } = await serverSupabase
        .from('office_locations')
        .select('*')
        .eq('id', officeId)
        .maybeSingle();
      if (data) {
        storedOffice = {
          id: String(data.id),
          code: data.code || undefined,
          name: data.name,
          address: data.address,
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
          allowedRadiusMeters: Number(data.allowed_radius_meters) || DEFAULT_ALLOWED_RADIUS_METERS,
          status: data.status === 'Inactive' ? 'Inactive' : 'Active',
        };
        officeLocationsStore.set(storedOffice.id, storedOffice);
      }
    } catch {
      // Ignore if table not migrated yet
    }
  }

  // 2. Also inspect employee record from Supabase field_force_reps if available
  let dbRepOffice: Partial<ResolvedOfficeConfig> | null = null;
  if (serverSupabase && body.employeeId) {
    try {
      const empIdNum = Number(body.employeeId);
      const query = !isNaN(empIdNum)
        ? serverSupabase.from('field_force_reps').select('*').eq('id', empIdNum).maybeSingle()
        : serverSupabase
            .from('field_force_reps')
            .select('*')
            .eq('code', body.employeeCode || body.employeeId)
            .maybeSingle();
      const { data: repRow } = await query;
      if (repRow && isValidCoordinatePair(Number(repRow.office_latitude), Number(repRow.office_longitude))) {
        dbRepOffice = {
          assignedOfficeId: repRow.assigned_office_id || officeId || 'custom',
          assignedOfficeName: repRow.assigned_office_name || 'Assigned Office',
          officeAddress: repRow.office_address || '',
          officeLatitude: Number(repRow.office_latitude),
          officeLongitude: Number(repRow.office_longitude),
          allowedRadiusMeters: Number(repRow.allowed_radius_meters) || DEFAULT_ALLOWED_RADIUS_METERS,
          locationStatus: repRow.location_status === 'Inactive' ? 'Inactive' : 'Active',
        };
      }
    } catch {
      // Ignore missing column errors
    }
  }

  const officeLatitude =
    dbRepOffice?.officeLatitude ??
    storedOffice?.latitude ??
    Number(body.officeLatitude);
  const officeLongitude =
    dbRepOffice?.officeLongitude ??
    storedOffice?.longitude ??
    Number(body.officeLongitude);

  const allowedRadiusMeters =
    Number(dbRepOffice?.allowedRadiusMeters) ||
    Number(storedOffice?.allowedRadiusMeters) ||
    Number(body.allowedRadiusMeters) ||
    DEFAULT_ALLOWED_RADIUS_METERS;

  const assignedOfficeId =
    dbRepOffice?.assignedOfficeId ||
    storedOffice?.id ||
    officeId ||
    'office-hq';

  const assignedOfficeName =
    dbRepOffice?.assignedOfficeName ||
    storedOffice?.name ||
    body.assignedOfficeName ||
    'Head Office';

  const officeAddress =
    dbRepOffice?.officeAddress ||
    storedOffice?.address ||
    body.officeAddress ||
    '';

  const locationStatus =
    dbRepOffice?.locationStatus ||
    storedOffice?.status ||
    (body.locationStatus === 'Inactive' ? 'Inactive' : 'Active');

  return {
    assignedOfficeId,
    assignedOfficeName,
    officeAddress,
    officeLatitude,
    officeLongitude,
    allowedRadiusMeters,
    locationStatus,
  };
}

function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentTimeHHmm(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function getCurrentTimeHHmmss(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

async function persistRejectedAttempt(attempt: RejectedAttendanceAttempt) {
  rejectedAttemptsStore.unshift(attempt);
  if (rejectedAttemptsStore.length > 1000) {
    rejectedAttemptsStore.pop();
  }
  if (serverSupabase) {
    try {
      await serverSupabase.from('attendance_rejected_attempts').insert({
        id: attempt.id,
        employee_id: attempt.employeeId,
        employee_code: attempt.employeeCode || null,
        employee_name: attempt.employeeName,
        department: attempt.department || null,
        designation: attempt.designation || null,
        assigned_office_id: attempt.assignedOfficeId || null,
        assigned_office_name: attempt.assignedOfficeName || null,
        office_latitude: attempt.officeLatitude ?? null,
        office_longitude: attempt.officeLongitude ?? null,
        allowed_radius_meters: attempt.allowedRadiusMeters,
        attempt_type: attempt.attemptType,
        attendance_date: attempt.attendanceDate,
        attempt_time: attempt.attemptTime,
        latitude: attempt.latitude ?? null,
        longitude: attempt.longitude ?? null,
        distance_meters: attempt.distanceMeters ?? null,
        gps_accuracy_meters: attempt.gpsAccuracyMeters ?? null,
        gps_validation_status: 'Rejected',
        rejection_reason: attempt.rejectionReason,
        device_info: attempt.deviceInfo || null,
      });
    } catch {
      // Non-fatal if table not yet created
    }
  }
}

async function persistAcceptedAttendance(record: AttendanceRecord) {
  const key = `${record.employeeId}_${record.date}`;
  attendanceRecordsStore.set(key, record);
  if (serverSupabase) {
    try {
      await serverSupabase.from('employee_attendances').upsert(
        {
          id: record.id,
          employee_id: record.employeeId || record.fieldForceId || '',
          employee_code: record.employeeCode || '',
          employee_name: record.employeeName,
          department: record.department || null,
          designation: record.designation || null,
          date: record.date,
          status: record.status,
          in_time: record.inTime || record.checkInTime || null,
          out_time: record.outTime || record.checkOutTime || null,
          overtime_hours: record.overtimeHours || 0,
          work_hours: record.workHours || 0,
          late_duration_minutes: record.lateDurationMinutes ?? record.lateMinutes ?? 0,
          assigned_office_id: record.assignedOfficeId || null,
          assigned_office_name: record.assignedOfficeName || null,
          office_latitude: record.officeLatitude ?? null,
          office_longitude: record.officeLongitude ?? null,
          allowed_radius_meters: record.allowedRadiusMeters ?? DEFAULT_ALLOWED_RADIUS_METERS,
          check_in_latitude: record.checkInLatitude ?? null,
          check_in_longitude: record.checkInLongitude ?? null,
          check_in_distance_meters: record.checkInDistanceMeters ?? null,
          check_in_gps_accuracy_meters: record.checkInGpsAccuracyMeters ?? null,
          check_in_location_text: record.checkInLocationText || null,
          check_out_latitude: record.checkOutLatitude ?? null,
          check_out_longitude: record.checkOutLongitude ?? null,
          check_out_distance_meters: record.checkOutDistanceMeters ?? null,
          check_out_gps_accuracy_meters: record.checkOutGpsAccuracyMeters ?? null,
          check_out_location_text: record.checkOutLocationText || null,
          gps_validation_status: record.gpsValidationStatus || 'Accepted',
          validation_reason: record.validationReason || null,
          remarks: record.remarks || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'employee_id,date' }
      );
    } catch {
      // Non-fatal if migration pending
    }
  }
}

export function createAppServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'ensec-erp-geofence-server' });
  });

  // --------------------------------------------------------------------------
  // Office Locations CRUD
  // --------------------------------------------------------------------------
  app.get('/api/office-locations', (_req, res) => {
    res.json({ locations: Array.from(officeLocationsStore.values()) });
  });

  app.post('/api/office-locations/sync', (req, res) => {
    const locations = Array.isArray(req.body?.locations) ? req.body.locations : [];
    for (const loc of locations) {
      if (loc && loc.id && loc.name) {
        officeLocationsStore.set(String(loc.id), {
          id: String(loc.id),
          code: loc.code,
          name: String(loc.name),
          address: String(loc.address || ''),
          latitude: Number(loc.latitude),
          longitude: Number(loc.longitude),
          allowedRadiusMeters: Number(loc.allowedRadiusMeters) || DEFAULT_ALLOWED_RADIUS_METERS,
          status: loc.status === 'Inactive' ? 'Inactive' : 'Active',
        });
      }
    }
    res.json({ synced: officeLocationsStore.size, locations: Array.from(officeLocationsStore.values()) });
  });

  app.post('/api/office-locations', async (req, res) => {
    const { id, code, name, address, latitude, longitude, allowedRadiusMeters, status } = req.body || {};
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!name || !isValidCoordinatePair(lat, lng)) {
      return res.status(400).json({ error: 'Valid office name, latitude, and longitude are required.' });
    }
    const loc: OfficeLocation = {
      id: id ? String(id) : `office-${Date.now().toString().slice(-6)}`,
      code: code ? String(code) : `OFF-${Date.now().toString().slice(-4)}`,
      name: String(name).trim(),
      address: String(address || '').trim(),
      latitude: lat,
      longitude: lng,
      allowedRadiusMeters: Number(allowedRadiusMeters) > 0 ? Number(allowedRadiusMeters) : DEFAULT_ALLOWED_RADIUS_METERS,
      status: status === 'Inactive' ? 'Inactive' : 'Active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    officeLocationsStore.set(loc.id, loc);
    if (serverSupabase) {
      try {
        await serverSupabase.from('office_locations').upsert({
          id: loc.id,
          code: loc.code,
          name: loc.name,
          address: loc.address,
          latitude: loc.latitude,
          longitude: loc.longitude,
          allowed_radius_meters: loc.allowedRadiusMeters,
          status: loc.status,
          updated_at: loc.updatedAt,
        });
      } catch {
        // Ignore if table not created yet
      }
    }
    return res.status(201).json({ location: loc });
  });

  app.put('/api/office-locations/:id', async (req, res) => {
    const locId = String(req.params.id);
    const existing = officeLocationsStore.get(locId);
    const body = req.body || {};
    const lat = body.latitude !== undefined ? Number(body.latitude) : existing?.latitude;
    const lng = body.longitude !== undefined ? Number(body.longitude) : existing?.longitude;
    if (!isValidCoordinatePair(lat, lng)) {
      return res.status(400).json({ error: 'Valid office latitude and longitude are required.' });
    }
    const updated: OfficeLocation = {
      id: locId,
      code: body.code ?? existing?.code,
      name: String(body.name ?? existing?.name ?? 'Office Location').trim(),
      address: String(body.address ?? existing?.address ?? '').trim(),
      latitude: lat!,
      longitude: lng!,
      allowedRadiusMeters:
        Number(body.allowedRadiusMeters ?? existing?.allowedRadiusMeters) || DEFAULT_ALLOWED_RADIUS_METERS,
      status: (body.status ?? existing?.status) === 'Inactive' ? 'Inactive' : 'Active',
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    officeLocationsStore.set(locId, updated);
    if (serverSupabase) {
      try {
        await serverSupabase.from('office_locations').upsert({
          id: updated.id,
          code: updated.code,
          name: updated.name,
          address: updated.address,
          latitude: updated.latitude,
          longitude: updated.longitude,
          allowed_radius_meters: updated.allowedRadiusMeters,
          status: updated.status,
          updated_at: updated.updatedAt,
        });
      } catch {
        // Ignore if table not created yet
      }
    }
    return res.json({ location: updated });
  });

  app.delete('/api/office-locations/:id', async (req, res) => {
    const locId = String(req.params.id);
    officeLocationsStore.delete(locId);
    if (serverSupabase) {
      try {
        await serverSupabase.from('office_locations').delete().eq('id', locId);
      } catch {}
    }
    res.json({ deleted: true, id: locId });
  });

  // --------------------------------------------------------------------------
  // Dry-Run GPS Distance Validation Endpoint
  // --------------------------------------------------------------------------
  app.post('/api/attendance/validate', async (req, res) => {
    const body = req.body || {};
    const office = await resolveOfficeForEmployee(body);
    const result = evaluateGeofenceAttendance({
      employeeLatitude: Number(body.latitude),
      employeeLongitude: Number(body.longitude),
      gpsAccuracyMeters:
        body.accuracy !== undefined && body.accuracy !== null ? Number(body.accuracy) : undefined,
      officeLatitude: office.officeLatitude,
      officeLongitude: office.officeLongitude,
      allowedRadiusMeters: office.allowedRadiusMeters,
      locationStatus: office.locationStatus,
      maxGpsAccuracyMeters: Number(body.maxGpsAccuracyMeters) || DEFAULT_MAX_GPS_ACCURACY_METERS,
    });
    res.json({
      ...result,
      office,
    });
  });

  // --------------------------------------------------------------------------
  // Authoritative Attendance Check-In (Backend + Haversine Validation)
  // --------------------------------------------------------------------------
  app.post('/api/attendance/check-in', async (req, res) => {
    const body = req.body || {};
    const employeeId = String(body.employeeId || '').trim();
    const employeeName = String(body.employeeName || '').trim();
    if (!employeeId || !employeeName) {
      return res.status(400).json({
        accepted: false,
        reason: 'Employee ID and Employee Name are required.',
      });
    }

    const attendanceDate = String(body.date || getTodayDateString()).slice(0, 10);
    const checkInTime = String(body.checkInTime || getCurrentTimeHHmm());
    const attemptTime = getCurrentTimeHHmmss();
    const key = `${employeeId}_${attendanceDate}`;

    // Check duplicate check-in on server store (and optional client existing record marker)
    const existing = attendanceRecordsStore.get(key);
    if ((existing && (existing.checkInTime || existing.inTime) && existing.gpsValidationStatus === 'Accepted') || body.hasExistingCheckIn) {
      return res.status(409).json({
        accepted: false,
        errorCode: 'DUPLICATE_CHECK_IN',
        reason: `Duplicate Check-In blocked: ${employeeName} has already checked in for ${attendanceDate}.`,
      });
    }

    const office = await resolveOfficeForEmployee(body);
    const empLat = Number(body.latitude);
    const empLng = Number(body.longitude);
    const gpsAccuracy =
      body.accuracy !== undefined && body.accuracy !== null ? Number(body.accuracy) : undefined;
    const prevPing = lastEmployeeGpsPing.get(employeeId);

    const validation = evaluateGeofenceAttendance({
      employeeLatitude: empLat,
      employeeLongitude: empLng,
      gpsAccuracyMeters: gpsAccuracy,
      officeLatitude: office.officeLatitude,
      officeLongitude: office.officeLongitude,
      allowedRadiusMeters: office.allowedRadiusMeters,
      locationStatus: office.locationStatus,
      maxGpsAccuracyMeters: Number(body.maxGpsAccuracyMeters) || DEFAULT_MAX_GPS_ACCURACY_METERS,
      previousCheckPoint: prevPing,
      currentTimestampMs: Date.now(),
    });

    if (!validation.accepted) {
      const rejectedAttempt: RejectedAttendanceAttempt = {
        id: `att-rej-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        employeeId,
        employeeCode: body.employeeCode ? String(body.employeeCode) : undefined,
        employeeName,
        department: body.department ? String(body.department) : undefined,
        designation: body.designation ? String(body.designation) : undefined,
        assignedOfficeId: office.assignedOfficeId,
        assignedOfficeName: office.assignedOfficeName,
        officeLatitude: isValidCoordinatePair(office.officeLatitude, office.officeLongitude)
          ? office.officeLatitude
          : undefined,
        officeLongitude: isValidCoordinatePair(office.officeLatitude, office.officeLongitude)
          ? office.officeLongitude
          : undefined,
        allowedRadiusMeters: validation.allowedRadiusMeters,
        attemptType: 'Check In',
        attendanceDate,
        attemptTime,
        latitude: Number.isFinite(empLat) ? empLat : undefined,
        longitude: Number.isFinite(empLng) ? empLng : undefined,
        distanceMeters: validation.distanceMeters,
        gpsAccuracyMeters: gpsAccuracy,
        gpsValidationStatus: 'Rejected',
        rejectionReason: validation.reason,
        deviceInfo: body.deviceInfo ? String(body.deviceInfo) : req.headers['user-agent'],
        createdAt: new Date().toISOString(),
      };
      await persistRejectedAttempt(rejectedAttempt);
      return res.status(403).json({
        accepted: false,
        errorCode: validation.errorCode,
        distanceMeters: validation.distanceMeters,
        allowedRadiusMeters: validation.allowedRadiusMeters,
        gpsValidationStatus: 'Rejected',
        reason: validation.reason,
        rejectedAttempt,
      });
    }

    lastEmployeeGpsPing.set(employeeId, {
      latitude: empLat,
      longitude: empLng,
      timestampMs: Date.now(),
    });

    const shiftCalc = calculateShiftAttendanceStatus({
      checkInTime,
      shiftStartTime: body.shiftStartTime || DEFAULT_SHIFT_START_TIME,
      gracePeriodMinutes:
        body.gracePeriodMinutes !== undefined
          ? Number(body.gracePeriodMinutes)
          : DEFAULT_GRACE_PERIOD_MINUTES,
      standardDailyHours: Number(body.standardDailyHours) || 8,
    });

    const nowIso = new Date().toISOString();
    const record: AttendanceRecord = {
      id: `att-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 5)}`,
      fieldForceId: employeeId,
      employeeId,
      employeeCode: body.employeeCode ? String(body.employeeCode) : undefined,
      employeeName,
      employeeCategory: body.employeeCategory,
      department: body.department ? String(body.department) : 'Operations',
      designation: body.designation ? String(body.designation) : undefined,
      date: attendanceDate,
      status: shiftCalc.status,
      inTime: checkInTime,
      checkInTime,
      isLate: shiftCalc.isLate,
      lateMinutes: shiftCalc.lateDurationMinutes,
      lateDurationMinutes: shiftCalc.lateDurationMinutes,
      workHours: 0,
      overtimeHours: 0,
      assignedOfficeId: office.assignedOfficeId,
      assignedOfficeName: office.assignedOfficeName,
      officeLatitude: office.officeLatitude,
      officeLongitude: office.officeLongitude,
      allowedRadiusMeters: validation.allowedRadiusMeters,
      checkInLatitude: empLat,
      checkInLongitude: empLng,
      checkInDistanceMeters: validation.distanceMeters,
      checkInGpsAccuracyMeters: gpsAccuracy,
      checkInLocationText: `${empLat.toFixed(6)}, ${empLng.toFixed(6)}`,
      gpsValidationStatus: 'Accepted',
      validationReason: validation.reason,
      remarks: `GPS Check-In Accepted (${validation.distanceMeters}m from ${office.assignedOfficeName})`,
      recordedBy: 'Mobile GPS Geofence',
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    await persistAcceptedAttendance(record);

    return res.status(200).json({
      accepted: true,
      distanceMeters: validation.distanceMeters,
      allowedRadiusMeters: validation.allowedRadiusMeters,
      gpsValidationStatus: 'Accepted',
      reason: validation.reason,
      record,
    });
  });

  // --------------------------------------------------------------------------
  // Authoritative Attendance Check-Out (Independent GPS Validation)
  // --------------------------------------------------------------------------
  app.post('/api/attendance/check-out', async (req, res) => {
    const body = req.body || {};
    const employeeId = String(body.employeeId || '').trim();
    const employeeName = String(body.employeeName || '').trim();
    if (!employeeId || !employeeName) {
      return res.status(400).json({
        accepted: false,
        reason: 'Employee ID and Employee Name are required.',
      });
    }

    const attendanceDate = String(body.date || getTodayDateString()).slice(0, 10);
    const checkOutTime = String(body.checkOutTime || getCurrentTimeHHmm());
    const attemptTime = getCurrentTimeHHmmss();
    const key = `${employeeId}_${attendanceDate}`;

    // Reconcile existing check-in from server store or client-synced existingRecord
    const existing: AttendanceRecord | undefined =
      attendanceRecordsStore.get(key) ||
      (body.existingRecord && body.existingRecord.date === attendanceDate
        ? (body.existingRecord as AttendanceRecord)
        : undefined);

    if (!existing || !(existing.checkInTime || existing.inTime) || existing.status === 'Absent') {
      return res.status(400).json({
        accepted: false,
        errorCode: 'NO_CHECK_IN',
        reason: `Cannot Check Out: No valid Check-In record found for ${employeeName} on ${attendanceDate}.`,
      });
    }

    if (existing.checkOutTime || existing.outTime) {
      return res.status(409).json({
        accepted: false,
        errorCode: 'DUPLICATE_CHECK_OUT',
        reason: `Duplicate Check-Out blocked: ${employeeName} has already checked out on ${attendanceDate} at ${existing.checkOutTime || existing.outTime}.`,
      });
    }

    const office = await resolveOfficeForEmployee(body);
    const empLat = Number(body.latitude);
    const empLng = Number(body.longitude);
    const gpsAccuracy =
      body.accuracy !== undefined && body.accuracy !== null ? Number(body.accuracy) : undefined;
    const prevPing = lastEmployeeGpsPing.get(employeeId);

    const validation = evaluateGeofenceAttendance({
      employeeLatitude: empLat,
      employeeLongitude: empLng,
      gpsAccuracyMeters: gpsAccuracy,
      officeLatitude: office.officeLatitude,
      officeLongitude: office.officeLongitude,
      allowedRadiusMeters: office.allowedRadiusMeters,
      locationStatus: office.locationStatus,
      maxGpsAccuracyMeters: Number(body.maxGpsAccuracyMeters) || DEFAULT_MAX_GPS_ACCURACY_METERS,
      previousCheckPoint: prevPing,
      currentTimestampMs: Date.now(),
    });

    if (!validation.accepted) {
      const rejectedAttempt: RejectedAttendanceAttempt = {
        id: `att-rej-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        employeeId,
        employeeCode: body.employeeCode ? String(body.employeeCode) : existing.employeeCode,
        employeeName,
        department: body.department ? String(body.department) : existing.department,
        designation: body.designation ? String(body.designation) : existing.designation,
        assignedOfficeId: office.assignedOfficeId,
        assignedOfficeName: office.assignedOfficeName,
        officeLatitude: isValidCoordinatePair(office.officeLatitude, office.officeLongitude)
          ? office.officeLatitude
          : undefined,
        officeLongitude: isValidCoordinatePair(office.officeLatitude, office.officeLongitude)
          ? office.officeLongitude
          : undefined,
        allowedRadiusMeters: validation.allowedRadiusMeters,
        attemptType: 'Check Out',
        attendanceDate,
        attemptTime,
        latitude: Number.isFinite(empLat) ? empLat : undefined,
        longitude: Number.isFinite(empLng) ? empLng : undefined,
        distanceMeters: validation.distanceMeters,
        gpsAccuracyMeters: gpsAccuracy,
        gpsValidationStatus: 'Rejected',
        rejectionReason: validation.reason,
        deviceInfo: body.deviceInfo ? String(body.deviceInfo) : req.headers['user-agent'],
        createdAt: new Date().toISOString(),
      };
      await persistRejectedAttempt(rejectedAttempt);
      return res.status(403).json({
        accepted: false,
        errorCode: validation.errorCode,
        distanceMeters: validation.distanceMeters,
        allowedRadiusMeters: validation.allowedRadiusMeters,
        gpsValidationStatus: 'Rejected',
        reason: validation.reason,
        rejectedAttempt,
      });
    }

    lastEmployeeGpsPing.set(employeeId, {
      latitude: empLat,
      longitude: empLng,
      timestampMs: Date.now(),
    });

    const checkInTimeStr = existing.checkInTime || existing.inTime || '09:00';
    const shiftCalc = calculateShiftAttendanceStatus({
      checkInTime: checkInTimeStr,
      checkOutTime,
      shiftStartTime: body.shiftStartTime || DEFAULT_SHIFT_START_TIME,
      gracePeriodMinutes:
        body.gracePeriodMinutes !== undefined
          ? Number(body.gracePeriodMinutes)
          : DEFAULT_GRACE_PERIOD_MINUTES,
      standardDailyHours: Number(body.standardDailyHours) || 8,
    });

    const updatedRecord: AttendanceRecord = {
      ...existing,
      outTime: checkOutTime,
      checkOutTime,
      workHours: shiftCalc.totalWorkingHours,
      overtimeHours: shiftCalc.overtimeHours,
      status: shiftCalc.status,
      isLate: existing.isLate ?? shiftCalc.isLate,
      lateMinutes: existing.lateMinutes ?? shiftCalc.lateDurationMinutes,
      lateDurationMinutes: existing.lateDurationMinutes ?? shiftCalc.lateDurationMinutes,
      checkOutLatitude: empLat,
      checkOutLongitude: empLng,
      checkOutDistanceMeters: validation.distanceMeters,
      checkOutGpsAccuracyMeters: gpsAccuracy,
      checkOutLocationText: `${empLat.toFixed(6)}, ${empLng.toFixed(6)}`,
      gpsValidationStatus: 'Accepted',
      validationReason: validation.reason,
      remarks: `${existing.remarks || ''} | Check-Out Accepted (${validation.distanceMeters}m)`.replace(/^\s*\|\s*/, ''),
      updatedAt: new Date().toISOString(),
    };

    await persistAcceptedAttendance(updatedRecord);

    return res.status(200).json({
      accepted: true,
      distanceMeters: validation.distanceMeters,
      allowedRadiusMeters: validation.allowedRadiusMeters,
      gpsValidationStatus: 'Accepted',
      reason: validation.reason,
      record: updatedRecord,
    });
  });

  app.get('/api/attendance/records', (_req, res) => {
    res.json({
      records: Array.from(attendanceRecordsStore.values()),
      rejectedAttempts: rejectedAttemptsStore,
    });
  });

  app.post('/api/attendance/sync', (req, res) => {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    for (const r of records) {
      if (r && r.employeeId && r.date) {
        attendanceRecordsStore.set(`${r.employeeId}_${r.date}`, r);
      }
    }
    res.json({ synced: attendanceRecordsStore.size });
  });

  // ============================================================================
  // MANUFACTURING COST VISIBILITY & COST SHEET AUTHORIZATION API
  // ============================================================================
  const mfgUsersCache = new Map<string, any>();
  const mfgOrdersCache = new Map<string, any>();
  const mfgIssuesCache = new Map<string, any>();
  const mfgRawMaterialsCache = new Map<string, any>();
  const mfgBatchesCache = new Map<string, any>();

  const indexUserInMfgCache = (u: any) => {
    if (!u || typeof u !== 'object') return;
    if (u.id) mfgUsersCache.set(String(u.id).toLowerCase(), u);
    if (u.userId) mfgUsersCache.set(String(u.userId).toLowerCase(), u);
    if (u.uid) mfgUsersCache.set(String(u.uid).toLowerCase(), u);
    if (u.email) mfgUsersCache.set(String(u.email).toLowerCase(), u);
  };

  const mapSupabaseUserRow = (row: any) => {
    let parsedPermissions = row.permissions;
    if (typeof parsedPermissions === 'string') {
      try {
        parsedPermissions = JSON.parse(parsedPermissions);
      } catch {
        parsedPermissions = null;
      }
    }
    return {
      id: row.uid ? String(row.uid) : `u-sb-${row.id}`,
      userId: row.uid || (row.email ? String(row.email).split('@')[0].toUpperCase() : `EMP-${row.id}`),
      name: row.name || 'Staff User',
      email: row.email || '',
      role: row.role || 'Field Force',
      department: row.department || '',
      status: row.status || 'Active',
      permissions: parsedPermissions || {},
    };
  };

  const resolveRequestUser = async (req: express.Request): Promise<any | null> => {
    const hdrId = String(req.headers['x-user-id'] || req.query.userId || '').trim();
    const hdrCode = String(req.headers['x-user-code'] || '').trim();
    const hdrEmail = String(req.headers['x-user-email'] || req.query.userEmail || '').trim();

    if (!hdrId && !hdrCode && !hdrEmail) {
      return null;
    }

    // 1. Prefer authoritative Supabase users table when available
    if (serverSupabase) {
      try {
        if (hdrEmail) {
          const { data } = await serverSupabase
            .from('users')
            .select('*')
            .ilike('email', hdrEmail)
            .limit(1)
            .maybeSingle();
          if (data) {
            const mapped = mapSupabaseUserRow(data);
            indexUserInMfgCache(mapped);
            return mapped;
          }
        }
        const lookupUid = hdrCode || hdrId;
        if (lookupUid) {
          const { data } = await serverSupabase
            .from('users')
            .select('*')
            .eq('uid', lookupUid)
            .limit(1)
            .maybeSingle();
          if (data) {
            const mapped = mapSupabaseUserRow(data);
            indexUserInMfgCache(mapped);
            return mapped;
          }
        }
        if (/^u-sb-(\d+)$/i.test(hdrId)) {
          const numId = Number(hdrId.replace(/^u-sb-/i, ''));
          const { data } = await serverSupabase
            .from('users')
            .select('*')
            .eq('id', numId)
            .limit(1)
            .maybeSingle();
          if (data) {
            const mapped = mapSupabaseUserRow(data);
            indexUserInMfgCache(mapped);
            return mapped;
          }
        }
      } catch {
        // Fall back to server in-memory store below
      }
    }

    // 2. Fallback to synchronized server user cache
    const candidates = [hdrId, hdrCode, hdrEmail]
      .map((s) => s.toLowerCase())
      .filter(Boolean);
    for (const key of candidates) {
      const hit = mfgUsersCache.get(key);
      if (hit) return hit;
    }

    return null;
  };

  app.post('/api/manufacturing/sync-state', (req, res) => {
    const body = req.body || {};
    if (Array.isArray(body.users)) {
      for (const u of body.users) {
        indexUserInMfgCache(u);
      }
    }
    if (Array.isArray(body.productionOrders)) {
      for (const po of body.productionOrders) {
        if (po && (po.id || po.orderNumber)) {
          mfgOrdersCache.set(String(po.id || po.orderNumber), po);
        }
      }
    }
    if (Array.isArray(body.materialIssues)) {
      for (const mi of body.materialIssues) {
        if (mi && (mi.id || mi.productionOrderId)) {
          mfgIssuesCache.set(String(mi.id || mi.productionOrderId), mi);
        }
      }
    }
    if (Array.isArray(body.rawMaterials)) {
      for (const rm of body.rawMaterials) {
        if (rm && (rm.id || rm.code)) {
          mfgRawMaterialsCache.set(String(rm.id || rm.code), rm);
        }
      }
    }
    if (Array.isArray(body.inventoryBatches)) {
      for (const b of body.inventoryBatches) {
        if (b && (b.id || b.batchNumber)) {
          mfgBatchesCache.set(String(b.id || b.batchNumber), b);
        }
      }
    }
    res.json({ ok: true });
  });

  app.get('/api/manufacturing/permissions', async (req, res) => {
    const caller = await resolveRequestUser(req);
    const permissions = resolveManufacturingCostPermissions(caller);
    res.json({ authenticated: Boolean(caller), permissions });
  });

  app.get('/api/manufacturing/production-orders', async (req, res) => {
    const caller = await resolveRequestUser(req);
    const permissions = resolveManufacturingCostPermissions(caller);

    let orders: any[] = Array.from(mfgOrdersCache.values());
    if (serverSupabase) {
      try {
        const { data } = await serverSupabase
          .from('production_orders')
          .select('*')
          .order('id', { ascending: false });
        if (Array.isArray(data) && data.length > 0) {
          orders = data.map((row: any) => ({
            id: String(row.id),
            orderNumber: row.order_number || row.orderNumber || `PO-${row.id}`,
            batchNumber: row.batch_number || row.batchNumber || '',
            productId: row.product_id || row.productId || '',
            productName: row.product_name || row.productName || '',
            model: row.model || '',
            plannedQty: Number(row.planned_qty ?? row.plannedQty ?? 0),
            completedQty: Number(row.completed_qty ?? row.completedQty ?? 0),
            rawMaterialCostBDT: Number(row.raw_material_cost_bdt ?? row.rawMaterialCostBDT ?? 0),
            conversionCostBDT: Number(row.conversion_cost_bdt ?? row.conversionCostBDT ?? 0),
            optimumLaborCostBDT: Number(row.optimum_labor_cost_bdt ?? row.optimumLaborCostBDT ?? 0),
            factoryOverheadBDT: Number(row.factory_overhead_bdt ?? row.factoryOverheadBDT ?? 0),
            costPerUnitBDT: Number(row.cost_per_unit_bdt ?? row.costPerUnitBDT ?? 0),
            totalProductionCostBDT: Number(row.total_production_cost_bdt ?? row.totalProductionCostBDT ?? 0),
            wastagePercent: Number(row.wastage_percent ?? row.wastagePercent ?? 0),
            scrapKg: Number(row.scrap_kg ?? row.scrapKg ?? 0),
            status: row.status || 'In Production',
            date: row.date || row.start_date || '',
            fgReceivingStatus: row.fg_receiving_status || row.fgReceivingStatus,
            receivedFgQty: row.received_fg_qty ?? row.receivedFgQty,
          }));
        }
      } catch {
        // Use in-memory cache fallback
      }
    }

    const sanitizedOrders = orders.map((order) => sanitizeProductionOrderForUser(order, caller));
    res.json({ permissions, orders: sanitizedOrders });
  });

  app.get('/api/manufacturing/cost-sheet/:orderId', async (req, res) => {
    const caller = await resolveRequestUser(req);
    const auth = authorizeCostSheetForUser(caller);
    if (!auth.allowed) {
      return res.status(403).json({
        allowed: false,
        code: 'COST_SHEET_FORBIDDEN',
        error: auth.reason || 'Forbidden: View Cost Sheet permission is disabled.',
      });
    }

    const rawOrderId = String(req.params.orderId || '').trim();
    const targetLower = rawOrderId.toLowerCase();

    let order = Array.from(mfgOrdersCache.values()).find(
      (po) =>
        String(po.id || '').toLowerCase() === targetLower ||
        String(po.orderNumber || '').toLowerCase() === targetLower ||
        String(po.batchNumber || '').toLowerCase() === targetLower
    );

    if (!order && serverSupabase) {
      try {
        const { data } = await serverSupabase.from('production_orders').select('*');
        if (Array.isArray(data)) {
          const hit = data.find(
            (row: any) =>
              String(row.id || '').toLowerCase() === targetLower ||
              String(row.order_number || '').toLowerCase() === targetLower ||
              String(row.batch_number || '').toLowerCase() === targetLower
          );
          if (hit) {
            order = {
              id: String(hit.id),
              orderNumber: hit.order_number || `PO-${hit.id}`,
              batchNumber: hit.batch_number || '',
              productId: hit.product_id || '',
              productName: hit.product_name || '',
              model: hit.model || '',
              plannedQty: Number(hit.planned_qty ?? 0),
              completedQty: Number(hit.completed_qty ?? 0),
              rawMaterialCostBDT: Number(hit.raw_material_cost_bdt ?? 0),
              conversionCostBDT: Number(hit.conversion_cost_bdt ?? 0),
              optimumLaborCostBDT: Number(hit.optimum_labor_cost_bdt ?? 0),
              factoryOverheadBDT: Number(hit.factory_overhead_bdt ?? 0),
              costPerUnitBDT: Number(hit.cost_per_unit_bdt ?? 0),
              totalProductionCostBDT: Number(hit.total_production_cost_bdt ?? 0),
              status: hit.status || 'In Production',
              date: hit.date || hit.start_date || '',
            };
          }
        }
      } catch {
        // Ignore if table unavailable
      }
    }

    if (!order) {
      return res.status(404).json({
        allowed: true,
        error: `Production order or batch "${rawOrderId}" not found.`,
      });
    }

    return res.status(200).json({
      allowed: true,
      order,
    });
  });

  app.get('/api/manufacturing/material-issue-context/:orderId', async (req, res) => {
    const caller = await resolveRequestUser(req);
    const rawOrderId = String(req.params.orderId || '').trim();
    const targetLower = rawOrderId.toLowerCase();

    const orders = Array.from(mfgOrdersCache.values());
    const order =
      orders.find(
        (po) =>
          String(po.id || '').toLowerCase() === targetLower ||
          String(po.orderNumber || '').toLowerCase() === targetLower ||
          String(po.batchNumber || '').toLowerCase() === targetLower
      ) || { id: rawOrderId, orderNumber: rawOrderId };

    const issues = Array.from(mfgIssuesCache.values());
    const existingIssue =
      issues.find(
        (mi) =>
          String(mi.productionOrderId || '').toLowerCase() === String(order.id || targetLower).toLowerCase() ||
          String(mi.productionOrderNumber || '').toLowerCase() === String(order.orderNumber || targetLower).toLowerCase()
      ) || null;

    let rawMaterials = Array.from(mfgRawMaterialsCache.values());
    let batches = Array.from(mfgBatchesCache.values());

    if (serverSupabase && rawMaterials.length === 0) {
      try {
        const { data: rmRows } = await serverSupabase.from('raw_materials').select('*');
        if (Array.isArray(rmRows)) {
          rawMaterials = rmRows.map((r: any) => ({
            id: String(r.id),
            code: r.code,
            name: r.name,
            unit: r.unit,
            category: r.category,
            stockKushtia: Number(r.stock_kushtia ?? r.stock ?? 0),
            lastPurchaseUnitCostBDT: Number(r.last_purchase_unit_cost_bdt ?? r.unit_cost ?? 0),
            standardCostBDT: Number(r.standard_cost_bdt ?? 0),
          }));
        }
      } catch {
        // Ignore if unavailable
      }
    }

    if (serverSupabase && batches.length === 0) {
      try {
        const { data: batchRows } = await serverSupabase.from('inventory_batches').select('*');
        if (Array.isArray(batchRows)) {
          batches = batchRows.map((b: any) => ({
            id: String(b.id),
            batchNumber: b.batch_number || b.batchNumber,
            batchBarcode: b.batch_barcode || b.batchBarcode,
            materialId: String(b.material_id || b.materialId || ''),
            materialCode: b.material_code || b.materialCode || '',
            materialName: b.material_name || b.materialName || '',
            unitPurchaseRate: Number(b.unit_purchase_rate ?? b.unitPurchaseRate ?? 0),
            availableQty: Number(b.available_qty ?? b.availableQty ?? 0),
            receivedQty: Number(b.received_qty ?? b.receivedQty ?? 0),
            issuedQty: Number(b.issued_qty ?? b.issuedQty ?? 0),
            status: b.status || 'Active',
          }));
        }
      } catch {
        // Ignore if unavailable
      }
    }

    const itemsSource = existingIssue?.items || [];
    const totalVal = itemsSource.reduce(
      (sum: number, it: any) => sum + (Number(it.totalMaterialCostBDT) || (Number(it.issuedQty || it.quantity || 0) * Number(it.unitCostBDT || it.unitCost || 0))),
      0
    );

    const sanitized = sanitizeMaterialIssueContextForUser(
      {
        order,
        existingIssue,
        items: itemsSource,
        batches,
        rawMaterials,
        totalMaterialIssueValue: existingIssue?.totalMaterialCostBDT ?? totalVal,
      },
      caller
    );

    return res.status(200).json(sanitized);
  });

  app.post('/api/manufacturing/material-issues', async (req, res) => {
    const caller = await resolveRequestUser(req);
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const batches = Array.from(mfgBatchesCache.values());
    const rawMaterials = Array.from(mfgRawMaterialsCache.values());

    // Authoritative server-side costing resolution (works even when user lacks View Batch Rate permission)
    let totalCost = 0;
    let totalQty = 0;
    const processedItems = items.map((item: any, idx: number) => {
      const qty = Math.max(0, Number(item.quantity) || 0);
      const batch = batches.find(
        (b) =>
          (item.batchId && String(b.id) === String(item.batchId)) ||
          (item.batchNumber && String(b.batchNumber) === String(item.batchNumber))
      );
      const rm = rawMaterials.find(
        (r) =>
          String(r.id) === String(item.materialId) ||
          (item.materialCode && String(r.code) === String(item.materialCode))
      );
      const authoritativeRate =
        Number(batch?.unitPurchaseRate) ||
        Number(rm?.lastPurchaseUnitCostBDT) ||
        Number(rm?.standardCostBDT) ||
        Number(item.unitCostBDT) ||
        0;
      const lineCost = qty * authoritativeRate;
      totalCost += lineCost;
      totalQty += qty;

      if (batch) {
        const nextAvail = Math.max(0, Number(batch.availableQty || 0) - qty);
        const nextIssued = Number(batch.issuedQty || 0) + qty;
        mfgBatchesCache.set(String(batch.id || batch.batchNumber), {
          ...batch,
          availableQty: nextAvail,
          issuedQty: nextIssued,
          status: nextAvail === 0 ? 'Depleted' : 'Active',
        });
      }

      return {
        id: `mii-srv-${Date.now()}-${idx}`,
        materialId: String(item.materialId || rm?.id || ''),
        materialCode: item.materialCode || rm?.code || '',
        materialName: item.materialName || rm?.name || '',
        batchNumber: item.batchNumber || batch?.batchNumber || '',
        batchBarcode: item.batchBarcode || batch?.batchBarcode || '',
        issuedQty: qty,
        unitCostBDT: authoritativeRate,
        totalMaterialCostBDT: lineCost,
      };
    });

    const issueRecord = {
      id: body.issueId || `mi-srv-${Date.now()}`,
      issueNumber: body.issueNumber || `MI-SRV-${Date.now().toString().slice(-4)}`,
      productionOrderId: String(body.productionOrderId || ''),
      productionOrderNumber: String(body.productionOrderNumber || ''),
      issuedBy: String(body.issuedBy || caller?.name || 'Production Supervisor'),
      issueDate: new Date().toISOString().slice(0, 10),
      totalIssuedQty: totalQty,
      totalMaterialCostBDT: totalCost,
      items: processedItems,
      status: 'Issued',
    };

    mfgIssuesCache.set(String(issueRecord.id), issueRecord);

    // Strip restricted financial fields from API response based on caller's permissions
    const sanitizedIssue = sanitizeMaterialIssueRecordForUser(issueRecord, caller);
    return res.status(200).json({
      success: true,
      issue: sanitizedIssue,
    });
  });

  // Compatibility fallbacks for existing MobileSalesPortal calls
  app.post('/api/orders', (_req, res) => res.json({ ok: true }));
  app.post('/api/customers', (_req, res) => res.json({ ok: true }));
  app.post('/api/tada', (_req, res) => res.json({ ok: true }));
  app.post('/api/warranty', (_req, res) => res.json({ ok: true }));

  return app;
}

async function startServer() {
  const app = createAppServer();
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ensec ERP Server running on http://0.0.0.0:${PORT}`);
  });
}

// Start server only when executed directly (allows unit testing createAppServer cleanly)
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start Ensec ERP Server:', err);
    process.exit(1);
  });
}
