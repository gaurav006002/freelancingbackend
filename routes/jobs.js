const express = require('express');
const { body, validationResult } = require('express-validator');
const Job = require('../models/Job');
const Bid = require('../models/Bid');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/jobs
// @desc    Get all jobs with filters
// @access  Public
router.get('/', async (req, res) => {
  try {
    const { category, search, page = 1, limit = 10, budget_min, budget_max } = req.query;
    
    let query = { status: 'open' };
    
    // Category filter
    if (category && category !== 'all') {
      query.category = category;
    }
    
    // Budget filter
    if (budget_min || budget_max) {
      query.budget = {};
      if (budget_min) query.budget.$gte = Number(budget_min);
      if (budget_max) query.budget.$lte = Number(budget_max);
    }
    
    // Search filter
    if (search) {
      query.$text = { $search: search };
    }
    
    const jobs = await Job.find(query)
      .populate('createdBy', 'name profilePic')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await Job.countDocuments(query);
    
    res.json({
      jobs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({ message: 'Server error fetching jobs' });
  }
});

// @route   GET /api/jobs/categories
// @desc    Get job categories
// @access  Public
router.get('/categories', (req, res) => {
  const categories = [
    'Web Development',
    'Mobile Development', 
    'Design',
    'Writing',
    'Data Entry',
    'Digital Marketing',
    'Video Editing',
    'Translation',
    'Other'
  ];
  res.json({ categories });
});

// @route   GET /api/jobs/user/posted
// @desc    Get jobs posted by current user
// @access  Private (Job Providers only)
router.get('/user/posted', [
  auth,
  authorize('job_provider')
], async (req, res) => {
  try {
    const jobs = await Job.find({ createdBy: req.user._id })
      .populate('assignedTo', 'name profilePic')
      .sort({ createdAt: -1 });
    
    res.json({ jobs });
  } catch (error) {
    console.error('Get user jobs error:', error);
    res.status(500).json({ message: 'Server error fetching user jobs' });
  }
});

// @route   GET /api/jobs/:id
// @desc    Get job by ID
// @access  Public
router.get('/:id', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .populate('createdBy', 'name profilePic bio')
      .populate('assignedTo', 'name profilePic');
    
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }
    
    res.json({ job });
  } catch (error) {
    console.error('Get job error:', error);
    res.status(500).json({ message: 'Server error fetching job' });
  }
});

// @route   POST /api/jobs
// @desc    Create new job
// @access  Private (Job Providers only)
router.post('/', [
  auth,
  authorize('job_provider'),
  body('title').trim().isLength({ min: 5 }).withMessage('Title must be at least 5 characters'),
  body('description').trim().isLength({ min: 20 }).withMessage('Description must be at least 20 characters'),
  body('category').isIn(['Web Development', 'Mobile Development', 'Design', 'Writing', 'Data Entry', 'Digital Marketing', 'Video Editing', 'Translation', 'Other']).withMessage('Invalid category'),
  body('budget').isNumeric().isFloat({ min: 1 }).withMessage('Budget must be a positive number')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      title,
      description,
      category,
      budget,
      budgetType,
      skills,
      duration,
      experienceLevel,
      attachments
    } = req.body;

    const job = new Job({
      title,
      description,
      category,
      budget,
      budgetType: budgetType || 'fixed',
      skills: skills || [],
      duration,
      experienceLevel: experienceLevel || 'intermediate',
      attachments: attachments || [],
      createdBy: req.user._id
    });

    await job.save();
    await job.populate('createdBy', 'name profilePic');

    res.status(201).json({
      message: 'Job created successfully',
      job
    });
  } catch (error) {
    console.error('Create job error:', error);
    res.status(500).json({ message: 'Server error creating job' });
  }
});

// @route   PUT /api/jobs/:id
// @desc    Update job
// @access  Private (Job owner only)
router.put('/:id', [
  auth,
  authorize('job_provider')
], async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }
    
    if (job.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this job' });
    }
    
    const allowedUpdates = ['title', 'description', 'budget', 'skills', 'status'];
    const updates = {};
    
    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });
    
    const updatedJob = await Job.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name profilePic');
    
    res.json({
      message: 'Job updated successfully',
      job: updatedJob
    });
  } catch (error) {
    console.error('Update job error:', error);
    res.status(500).json({ message: 'Server error updating job' });
  }
});

// @route   DELETE /api/jobs/:id
// @desc    Delete job
// @access  Private (Job owner only)
router.delete('/:id', [
  auth,
  authorize('job_provider')
], async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }
    
    if (job.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this job' });
    }
    
    await Job.findByIdAndDelete(req.params.id);
    await Bid.deleteMany({ jobId: req.params.id });
    
    res.json({ message: 'Job deleted successfully' });
  } catch (error) {
    console.error('Delete job error:', error);
    res.status(500).json({ message: 'Server error deleting job' });
  }
});

module.exports = router;
