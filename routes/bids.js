const express = require('express');
const { body, validationResult } = require('express-validator');
const Bid = require('../models/Bid');
const Job = require('../models/Job');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// @route   POST /api/bids
// @desc    Create a new bid
// @access  Private (Freelancers only)
router.post('/', [
  auth,
  authorize('freelancer'),
  body('jobId').isMongoId().withMessage('Invalid job ID'),
  body('bidAmount').isNumeric().isFloat({ min: 1 }).withMessage('Bid amount must be a positive number'),
  body('message').trim().isLength({ min: 10 }).withMessage('Message must be at least 10 characters'),
  body('deliveryTime').isInt({ min: 1 }).withMessage('Delivery time must be at least 1 day')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { jobId, bidAmount, message, deliveryTime, attachments } = req.body;

    // Check if job exists and is open
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    if (job.status !== 'open') {
      return res.status(400).json({ message: 'Job is not open for bidding' });
    }

    // Check if freelancer already bid on this job
    const existingBid = await Bid.findOne({
      freelancerId: req.user._id,
      jobId: jobId
    });

    if (existingBid) {
      return res.status(400).json({ message: 'You have already bid on this job' });
    }

    // Create new bid
    const bid = new Bid({
      freelancerId: req.user._id,
      jobId,
      bidAmount,
      message,
      deliveryTime,
      attachments: attachments || []
    });

    await bid.save();

    // Update job bids count
    await Job.findByIdAndUpdate(jobId, {
      $inc: { bidsCount: 1 }
    });

    await bid.populate('freelancerId', 'name profilePic');

    res.status(201).json({
      message: 'Bid submitted successfully',
      bid
    });
  } catch (error) {
    console.error('Create bid error:', error);
    res.status(500).json({ message: 'Server error creating bid' });
  }
});

// @route   GET /api/bids/job/:jobId
// @desc    Get all bids for a job
// @access  Private (Job owner only)
router.get('/job/:jobId', auth, async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId);
    
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    // Only job owner can see bids
    if (job.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to view bids for this job' });
    }

    const bids = await Bid.find({ jobId: req.params.jobId })
      .populate('freelancerId', 'name profilePic bio skills hourlyRate')
      .sort({ createdAt: -1 });

    res.json({ bids });
  } catch (error) {
    console.error('Get job bids error:', error);
    res.status(500).json({ message: 'Server error fetching bids' });
  }
});

// @route   GET /api/bids/freelancer
// @desc    Get all bids by current freelancer
// @access  Private (Freelancers only)
router.get('/freelancer', [
  auth,
  authorize('freelancer')
], async (req, res) => {
  try {
    const bids = await Bid.find({ freelancerId: req.user._id })
      .populate('jobId', 'title budget status createdBy')
      .populate({
        path: 'jobId',
        populate: {
          path: 'createdBy',
          select: 'name profilePic'
        }
      })
      .sort({ createdAt: -1 });

    res.json({ bids });
  } catch (error) {
    console.error('Get freelancer bids error:', error);
    res.status(500).json({ message: 'Server error fetching bids' });
  }
});

// @route   PUT /api/bids/:id/accept
// @desc    Accept a bid
// @access  Private (Job owner only)
router.put('/:id/accept', auth, async (req, res) => {
  try {
    const bid = await Bid.findById(req.params.id)
      .populate('jobId')
      .populate('freelancerId', 'name email');

    if (!bid) {
      return res.status(404).json({ message: 'Bid not found' });
    }

    // Check if user owns the job
    if (bid.jobId.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to accept this bid' });
    }

    // Check if job is still open
    if (bid.jobId.status !== 'open') {
      return res.status(400).json({ message: 'Job is no longer open' });
    }

    // Accept the bid
    bid.status = 'accepted';
    await bid.save();

    // Update job status and assign to freelancer
    await Job.findByIdAndUpdate(bid.jobId._id, {
      status: 'in_progress',
      assignedTo: bid.freelancerId._id
    });

    // Reject all other bids for this job
    await Bid.updateMany(
      { jobId: bid.jobId._id, _id: { $ne: bid._id } },
      { status: 'rejected' }
    );

    res.json({
      message: 'Bid accepted successfully',
      bid
    });
  } catch (error) {
    console.error('Accept bid error:', error);
    res.status(500).json({ message: 'Server error accepting bid' });
  }
});

// @route   PUT /api/bids/:id/reject
// @desc    Reject a bid
// @access  Private (Job owner only)
router.put('/:id/reject', auth, async (req, res) => {
  try {
    const bid = await Bid.findById(req.params.id).populate('jobId');

    if (!bid) {
      return res.status(404).json({ message: 'Bid not found' });
    }

    // Check if user owns the job
    if (bid.jobId.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to reject this bid' });
    }

    bid.status = 'rejected';
    await bid.save();

    res.json({
      message: 'Bid rejected successfully',
      bid
    });
  } catch (error) {
    console.error('Reject bid error:', error);
    res.status(500).json({ message: 'Server error rejecting bid' });
  }
});

// @route   DELETE /api/bids/:id
// @desc    Delete a bid (freelancer can delete their own bid)
// @access  Private (Bid owner only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const bid = await Bid.findById(req.params.id);

    if (!bid) {
      return res.status(404).json({ message: 'Bid not found' });
    }

    // Check if user owns the bid
    if (bid.freelancerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this bid' });
    }

    // Can only delete pending bids
    if (bid.status !== 'pending') {
      return res.status(400).json({ message: 'Cannot delete a bid that has been accepted or rejected' });
    }

    await Bid.findByIdAndDelete(req.params.id);

    // Update job bids count
    await Job.findByIdAndUpdate(bid.jobId, {
      $inc: { bidsCount: -1 }
    });

    res.json({ message: 'Bid deleted successfully' });
  } catch (error) {
    console.error('Delete bid error:', error);
    res.status(500).json({ message: 'Server error deleting bid' });
  }
});

module.exports = router;
