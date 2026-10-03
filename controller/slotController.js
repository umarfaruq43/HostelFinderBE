const mongoose = require('mongoose');
const { Slot, Property, ProviderProfile, StudentProfile } = require('../model/collectionsModel');

// ---- US-18 limits (MVP) ---------------------------------------------------
const DEFAULT_SLOT_MINUTES = 30;
const MIN_SLOT_MINUTES = 15;
const MAX_SLOT_MINUTES = 120;
const MAX_WINDOW_HOURS = 12;        // one availability window can't span more than this
const MAX_WINDOWS_PER_REQUEST = 14;
const MAX_SLOTS_PER_REQUEST = 200;
const MINUTE_MS = 60 * 1000;
// ---------------------------------------------------------------------------

async function getProviderProfile(userId) {
  return ProviderProfile.findOne({ userId });
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

// POST /slots  (provider only)
// The landlord enters availability windows; the system converts each window
// into bookable slots of `slotMinutes` (default 30). No external calendar.
// body: {
//   propertyId,
//   slotMinutes?: 15-120 (default 30),
//   windows: [{ start: '2026-10-05T17:00:00+01:00', end: '2026-10-05T19:00:00+01:00' }]
// }
// Times are ISO 8601 WITH a UTC offset so there is no timezone guessing.
// Only whole slots are created — a leftover shorter than slotMinutes is dropped.
// Slots that overlap ones already published for the property are skipped.
async function createSlots(req, res) {
  try {
    const provider = await getProviderProfile(req.user._id);
    if (!provider) return res.status(404).json({ message: 'Provider profile not found' });

    const { propertyId, windows } = req.body;
    const slotMinutes = req.body.slotMinutes === undefined ? DEFAULT_SLOT_MINUTES : Number(req.body.slotMinutes);

    if (!propertyId || !mongoose.isValidObjectId(propertyId)) {
      return res.status(400).json({ message: 'A valid propertyId is required' });
    }
    if (!Number.isInteger(slotMinutes) || slotMinutes < MIN_SLOT_MINUTES || slotMinutes > MAX_SLOT_MINUTES) {
      return res.status(400).json({
        message: `slotMinutes must be a whole number between ${MIN_SLOT_MINUTES} and ${MAX_SLOT_MINUTES}`,
      });
    }
    if (!Array.isArray(windows) || windows.length === 0) {
      return res.status(400).json({ message: 'windows must be a non-empty array of { start, end }' });
    }
    if (windows.length > MAX_WINDOWS_PER_REQUEST) {
      return res.status(400).json({ message: `You can add at most ${MAX_WINDOWS_PER_REQUEST} windows at a time` });
    }

    const property = await Property.findById(propertyId);
    if (!property) return res.status(404).json({ message: 'Property not found' });
    if (!provider._id.equals(property.providerId)) {
      return res.status(403).json({ message: 'You do not own this property' });
    }

    // ---- Validate windows and split them into slots -----------------------
    const now = new Date();
    const slotMs = slotMinutes * MINUTE_MS;
    const generated = []; // { startsAt, endsAt }

    for (let i = 0; i < windows.length; i += 1) {
      const w = windows[i] || {};
      const start = new Date(w.start);
      const end = new Date(w.end);

      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return res.status(400).json({ message: `windows[${i}]: start and end must be valid ISO date-times` });
      }
      if (end <= start) {
        return res.status(400).json({ message: `windows[${i}]: end must be after start` });
      }
      if (start <= now) {
        return res.status(400).json({ message: `windows[${i}]: start must be in the future` });
      }
      if (end - start > MAX_WINDOW_HOURS * 60 * MINUTE_MS) {
        return res.status(400).json({ message: `windows[${i}]: a window cannot be longer than ${MAX_WINDOW_HOURS} hours` });
      }
      if (end - start < slotMs) {
        return res.status(400).json({ message: `windows[${i}]: window is shorter than one ${slotMinutes}-minute slot` });
      }

      for (let t = start.getTime(); t + slotMs <= end.getTime(); t += slotMs) {
        generated.push({ startsAt: new Date(t), endsAt: new Date(t + slotMs) });
      }
    }

    if (generated.length > MAX_SLOTS_PER_REQUEST) {
      return res.status(400).json({
        message: `That would create ${generated.length} slots; the limit is ${MAX_SLOTS_PER_REQUEST} per request`,
      });
    }

    // ---- Drop overlaps: with each other, then with existing slots ----------
    generated.sort((a, b) => a.startsAt - b.startsAt);
    const unique = [];
    for (const g of generated) {
      const last = unique[unique.length - 1];
      if (!last || !overlaps(g.startsAt, g.endsAt, last.startsAt, last.endsAt)) unique.push(g);
    }

    const rangeStart = unique[0].startsAt;
    const rangeEnd = unique[unique.length - 1].endsAt;
    const existing = await Slot.find({
      propertyId: property._id,
      startsAt: { $lt: rangeEnd },
      endsAt: { $gt: rangeStart },
    }).select('startsAt endsAt');

    const fresh = unique.filter(
      (g) => !existing.some((e) => overlaps(g.startsAt, g.endsAt, e.startsAt, e.endsAt))
    );
    const skipped = generated.length - fresh.length;

    if (fresh.length === 0) {
      return res.status(409).json({ message: 'All of those times already have slots for this property' });
    }

    let slots;
    try {
      slots = await Slot.insertMany(
        fresh.map((g) => ({
          propertyId: property._id,
          providerId: provider._id,
          startsAt: g.startsAt,
          endsAt: g.endsAt,
        }))
      );
    } catch (err) {
      // Unique index (propertyId + startsAt) tripped by a concurrent request
      if (err.code === 11000) {
        return res.status(409).json({ message: 'Some of those slots were just created by another request — please retry' });
      }
      throw err;
    }

    return res.status(201).json({ created: slots.length, skipped, slots });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to create slots', error: err.message });
  }
}

// GET /slots/mine?propertyId=&status=open|booked&includePast=true  (provider only)
// Upcoming slots by default, soonest first.
async function getMySlots(req, res) {
  try {
    const provider = await getProviderProfile(req.user._id);
    if (!provider) return res.status(404).json({ message: 'Provider profile not found' });

    const { propertyId, status, includePast } = req.query;
    const filter = { providerId: provider._id };

    if (propertyId !== undefined) {
      if (!mongoose.isValidObjectId(propertyId)) return res.status(400).json({ message: 'Invalid propertyId' });
      filter.propertyId = propertyId;
    }
    if (status !== undefined) {
      if (!['open', 'booked'].includes(status)) {
        return res.status(400).json({ message: 'status must be open or booked' });
      }
      filter.status = status;
    }
    if (includePast !== 'true') filter.startsAt = { $gt: new Date() };

    const slots = await Slot.find(filter).sort({ startsAt: 1 });
    return res.json({ count: slots.length, slots });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch slots', error: err.message });
  }
}

// GET /slots/property/:propertyId
// Open, upcoming slots for a property. Automatically ensures default open slots exist.
// Returns count, raw slots array, and groupedByDate formatted for the date/time selector UI.
async function getPropertySlots(req, res) {
  try {
    const { propertyId } = req.params;
    if (!mongoose.isValidObjectId(propertyId)) {
      return res.status(404).json({ message: 'Property not found' });
    }

    const property = await Property.findById(propertyId).select('verificationStatus availabilityStatus providerId');
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    // Role-specific visibility rules
    if (req.user && req.user.role === 'student') {
      const student = await StudentProfile.findOne({ userId: req.user._id });
      if (!student || student.verificationStatus !== 'verified') {
        return res.status(403).json({ message: 'Student verification required to view slots' });
      }
      if (property.verificationStatus !== 'verified') {
        return res.status(404).json({ message: 'Property not found' });
      }
      if (property.availabilityStatus !== 'available') {
        return res.status(400).json({ message: 'Property is not available' });
      }
    }

    // Fetch open upcoming slots
    let slots = await Slot.find({
      propertyId: property._id,
      status: 'open',
      startsAt: { $gt: new Date() },
    })
      .select('propertyId startsAt endsAt status')
      .sort({ startsAt: 1 });

    // If no slots exist yet, automatically generate them
    if (slots.length === 0) {
      await generateDefaultSlots(property._id, property.providerId);
      slots = await Slot.find({
        propertyId: property._id,
        status: 'open',
        startsAt: { $gt: new Date() },
      })
        .select('propertyId startsAt endsAt status')
        .sort({ startsAt: 1 });
    }

    // Group slots by date for frontend UI consumption matching sample
    const groupedMap = new Map();
    for (const slot of slots) {
      const d = new Date(slot.startsAt);
      const dateKey = d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // YYYY-MM-DD
      const weekday = d.toLocaleDateString('en-US', { timeZone: 'Africa/Lagos', weekday: 'short' });
      const day = d.toLocaleDateString('en-US', { timeZone: 'Africa/Lagos', day: 'numeric' });
      const month = d.toLocaleDateString('en-US', { timeZone: 'Africa/Lagos', month: 'short' });
      const dateLabel = `${weekday} ${day} ${month}`;

      const startTime = d.toLocaleTimeString('en-US', {
        timeZone: 'Africa/Lagos',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      const endTime = new Date(slot.endsAt).toLocaleTimeString('en-US', {
        timeZone: 'Africa/Lagos',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      const timeLabel = `${startTime} – ${endTime}`;

      if (!groupedMap.has(dateKey)) {
        groupedMap.set(dateKey, {
          date: dateKey,
          label: dateLabel,
          weekday,
          day: Number(day),
          month,
          slots: [],
        });
      }

      groupedMap.get(dateKey).slots.push({
        _id: slot._id,
        propertyId: slot.propertyId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        timeLabel,
        status: slot.status,
      });
    }

    const groupedByDate = Array.from(groupedMap.values());

    return res.json({ count: slots.length, slots, groupedByDate });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to fetch slots', error: err.message });
  }
}

// Generates default inspection slots for a property matching the standard schedule:
// Next 10 weekdays (Monday to Friday, 2 weeks) with 4 time slots per day:
// - 2:00 PM – 3:00 PM (14:00 to 15:00)
// - 4:00 PM – 5:00 PM (16:00 to 17:00)
// - 5:00 PM – 6:00 PM (17:00 to 18:00)
// - 6:00 PM – 7:00 PM (18:00 to 19:00)
async function generateDefaultSlots(propertyId, providerId, daysAhead = 10) {
  try {
    const now = new Date();
    const slotTimes = [
      { startHour: 14, endHour: 15 }, // 2:00 PM – 3:00 PM
      { startHour: 16, endHour: 17 }, // 4:00 PM – 5:00 PM
      { startHour: 17, endHour: 18 }, // 5:00 PM – 6:00 PM
      { startHour: 18, endHour: 19 }, // 6:00 PM – 7:00 PM
    ];

    const slotsToCreate = [];
    const cursor = new Date(now);

    let weekdaysCount = 0;
    while (weekdaysCount < daysAhead) {
      cursor.setDate(cursor.getDate() + 1);
      const dayOfWeek = cursor.getDay();
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        weekdaysCount++;
        const year = cursor.getFullYear();
        const month = String(cursor.getMonth() + 1).padStart(2, '0');
        const day = String(cursor.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;

        for (const t of slotTimes) {
          const startStr = `${dateStr}T${String(t.startHour).padStart(2, '0')}:00:00+01:00`;
          const endStr = `${dateStr}T${String(t.endHour).padStart(2, '0')}:00:00+01:00`;
          const startsAt = new Date(startStr);
          const endsAt = new Date(endStr);

          if (startsAt > now) {
            slotsToCreate.push({
              propertyId,
              providerId,
              startsAt,
              endsAt,
              status: 'open',
            });
          }
        }
      }
    }

    if (slotsToCreate.length === 0) return [];

    const existing = await Slot.find({
      propertyId,
      startsAt: { $in: slotsToCreate.map((s) => s.startsAt) },
    }).select('startsAt');

    const existingTimes = new Set(existing.map((e) => e.startsAt.getTime()));
    const fresh = slotsToCreate.filter((s) => !existingTimes.has(s.startsAt.getTime()));

    if (fresh.length === 0) return [];

    const created = await Slot.insertMany(fresh, { ordered: false });
    return created;
  } catch (err) {
    console.error('Error generating default slots:', err.message);
    return [];
  }
}

// DELETE /slots/:id  (provider, owner only) — removes an OPEN slot.
// Booked slots are handled by the booking cancel/reschedule flow (US-20).
async function deleteSlot(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Slot not found' });
    }
    const provider = await getProviderProfile(req.user._id);
    if (!provider) return res.status(404).json({ message: 'Provider profile not found' });

    // Atomic: only deletes if it's this provider's slot AND still open,
    // so a slot can't be removed out from under a student who just booked it.
    const deleted = await Slot.findOneAndDelete({
      _id: req.params.id,
      providerId: provider._id,
      status: 'open',
    });
    if (deleted) return res.json({ message: 'Slot removed' });

    const slot = await Slot.findById(req.params.id).select('providerId status');
    if (!slot) return res.status(404).json({ message: 'Slot not found' });
    if (!provider._id.equals(slot.providerId)) {
      return res.status(403).json({ message: 'You do not own this slot' });
    }
    return res.status(409).json({ message: 'This slot is already booked and cannot be removed here' });
  } catch (err) {
    return res.status(500).json({ message: 'Failed to remove slot', error: err.message });
  }
}

module.exports = { createSlots, getMySlots, getPropertySlots, deleteSlot, generateDefaultSlots };