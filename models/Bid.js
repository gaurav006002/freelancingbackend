const mongoose = require('mongoose');

const bidSchema = new mongoose.Schema({
  freelancerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  bidAmount: {
    type: Number,
    required: true,
    min: 0
  },
  message: {
    type: String,
    required: true
  },
  deliveryTime: {
    type: Number, // in days
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected'],
    default: 'pending'
  },
  attachments: [{
    url: String,
    filename: String
  }]
}, {
  timestamps: true
});

// Ensure one bid per freelancer per job
bidSchema.index({ freelancerId: 1, jobId: 1 }, { unique: true });

module.exports = mongoose.model('Bid', bidSchema);
