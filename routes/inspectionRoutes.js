const express = require('express');
const router = express.Router();
const {
  requestInspection,
  getMyInspections,
  getReceivedInspections,
  getInspectionById,
  scheduleInspection,
  declineInspection,
  confirmInspection,
  rescheduleInspection,
  rescheduleMyInspection,
  missedInspection,
  completeInspection,
  proceedInspection,
  rejectInspection,
  cancelInspection,
} = require('../controller/inspectionController');
const { protect, authorize } = require('../middleware/auth');

// /mine and /received must come before /:id or Express reads them as an id
router.post('/', protect, authorize('student'), requestInspection);
router.get('/mine', protect, authorize('student'), getMyInspections);
router.get('/received', protect, authorize('provider'), getReceivedInspections);
router.get('/:id', protect, getInspectionById);
router.put('/:id/schedule', protect, authorize('provider'), scheduleInspection);
router.put('/:id/decline', protect, authorize('provider'), declineInspection);
router.put('/:id/confirm', protect, authorize('student'), confirmInspection)
router.put('/:id/reschedule', protect, authorize('provider'), rescheduleInspection);
router.put('/:id/reschedule-mine', protect, authorize('student'), rescheduleMyInspection);
router.put('/:id/missed', protect, authorize('provider'), missedInspection);
router.put('/:id/complete', protect, authorize('provider'), completeInspection);
router.put('/:id/proceed', protect, authorize('student'), proceedInspection);
router.put('/:id/reject', protect, authorize('student'), rejectInspection);
router.delete('/:id', protect, authorize('student'), cancelInspection);

module.exports = router;