const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const Payment = require('../models/Payment');
const Job = require('../models/Job');
const User = require('../models/User');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// @route   POST /api/payment/create-order
// @desc    Create Razorpay order for job payment
// @access  Private (Job Providers only)
router.post('/create-order', [
  auth,
  authorize('job_provider'),
  body('jobId').isMongoId().withMessage('Invalid job ID'),
  body('amount').isNumeric().isFloat({ min: 1 }).withMessage('Amount must be a positive number')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { jobId, amount, description } = req.body;

    // Verify job exists and belongs to user
    const job = await Job.findById(jobId).populate('assignedTo', 'name email');
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }

    if (job.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to make payment for this job' });
    }

    if (!job.assignedTo) {
      return res.status(400).json({ message: 'Job has not been assigned to any freelancer' });
    }

    // Create Razorpay order
    const options = {
      amount: Math.round(amount * 100), // Convert to paise
      currency: 'INR',
      receipt: `job_${jobId}_${Date.now()}`,
      notes: {
        jobId: jobId,
        payerId: req.user._id.toString(),
        payeeId: job.assignedTo._id.toString()
      }
    };

    const order = await razorpay.orders.create(options);

    // Save payment record
    const payment = new Payment({
      jobId,
      payerId: req.user._id,
      payeeId: job.assignedTo._id,
      amount,
      razorpayOrderId: order.id,
      description: description || `Payment for job: ${job.title}`
    });

    await payment.save();

    res.json({
      message: 'Payment order created successfully',
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      paymentId: payment._id
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ message: 'Server error creating payment order' });
  }
});

// @route   POST /api/payment/verify
// @desc    Verify Razorpay payment
// @access  Private
router.post('/verify', [
  auth,
  body('razorpay_order_id').exists().withMessage('Order ID is required'),
  body('razorpay_payment_id').exists().withMessage('Payment ID is required'),
  body('razorpay_signature').exists().withMessage('Signature is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    // Find payment record
    const payment = await Payment.findOne({ razorpayOrderId: razorpay_order_id })
      .populate('jobId', 'title')
      .populate('payerId', 'name email')
      .populate('payeeId', 'name email');

    if (!payment) {
      return res.status(404).json({ message: 'Payment record not found' });
    }

    // Verify signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      payment.status = 'failed';
      await payment.save();
      return res.status(400).json({ message: 'Invalid payment signature' });
    }

    // Update payment status
    payment.razorpayPaymentId = razorpay_payment_id;
    payment.razorpaySignature = razorpay_signature;
    payment.status = 'paid';
    await payment.save();

    // Update job status to completed
    await Job.findByIdAndUpdate(payment.jobId._id, {
      status: 'completed'
    });

    res.json({
      message: 'Payment verified successfully',
      payment: {
        id: payment._id,
        amount: payment.amount,
        status: payment.status,
        job: payment.jobId.title
      }
    });
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({ message: 'Server error verifying payment' });
  }
});

// @route   GET /api/payment/history
// @desc    Get payment history for current user
// @access  Private
router.get('/history', auth, async (req, res) => {
  try {
    let query = {};
    
    if (req.user.role === 'job_provider') {
      query.payerId = req.user._id;
    } else {
      query.payeeId = req.user._id;
    }

    const payments = await Payment.find(query)
      .populate('jobId', 'title description')
      .populate('payerId', 'name email')
      .populate('payeeId', 'name email')
      .sort({ createdAt: -1 });

    res.json({ payments });
  } catch (error) {
    console.error('Get payment history error:', error);
    res.status(500).json({ message: 'Server error fetching payment history' });
  }
});

// @route   GET /api/payment/:id
// @desc    Get payment details by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('jobId', 'title description')
      .populate('payerId', 'name email')
      .populate('payeeId', 'name email');

    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    // Check if user is involved in this payment
    if (payment.payerId._id.toString() !== req.user._id.toString() &&
        payment.payeeId._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to view this payment' });
    }

    res.json({ payment });
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ message: 'Server error fetching payment' });
  }
});

// @route   POST /api/payment/webhook
// @desc    Handle Razorpay webhooks
// @access  Public (but verified)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const body = req.body;

    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (signature !== expectedSignature) {
      return res.status(400).json({ message: 'Invalid webhook signature' });
    }

    const event = JSON.parse(body);

    // Handle different webhook events
    switch (event.event) {
      case 'payment.captured':
        // Payment was successful
        await handlePaymentCaptured(event.payload.payment.entity);
        break;
      
      case 'payment.failed':
        // Payment failed
        await handlePaymentFailed(event.payload.payment.entity);
        break;
      
      default:
        console.log('Unhandled webhook event:', event.event);
    }

    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ message: 'Webhook processing error' });
  }
});

// Helper function to handle successful payments
async function handlePaymentCaptured(paymentData) {
  try {
    const payment = await Payment.findOne({
      razorpayOrderId: paymentData.order_id
    });

    if (payment) {
      payment.status = 'paid';
      payment.razorpayPaymentId = paymentData.id;
      await payment.save();

      // Update job status
      await Job.findByIdAndUpdate(payment.jobId, {
        status: 'completed'
      });
    }
  } catch (error) {
    console.error('Handle payment captured error:', error);
  }
}

// Helper function to handle failed payments
async function handlePaymentFailed(paymentData) {
  try {
    const payment = await Payment.findOne({
      razorpayOrderId: paymentData.order_id
    });

    if (payment) {
      payment.status = 'failed';
      await payment.save();
    }
  } catch (error) {
    console.error('Handle payment failed error:', error);
  }
}

module.exports = router;
