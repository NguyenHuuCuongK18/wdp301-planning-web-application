const mongoose = require('mongoose');
const User = require('../models/userModel');
const Board = require('../models/boardModel');
const Skill = require('../models/skillModel');
const AppError = require('../utils/appError');

exports.getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select(
      '-password -passwordResetToken -passwordResetExpires'
    );
    if (!user) {
      return next(new AppError('User not found.', 404));
    }

    // Check if user has password to determine if they can unlink Google account
    const hasPassword = !!(user.password && user.password.trim());

    res.status(200).json({
      status: 'success',
      data: {
        user: {
          id: user._id,
          fullname: user.fullname || '',
          username: user.username || '',
          email: user.email,
          role: user.role,
          avatar: user.avatar || null,
          // now an array of lowercase strings
          skills: user.skills || [],
          about: user.about || '',
          experience: user.experience || '',
          yearOfExperience: user.yearOfExperience || 0,
          availability: user.availability || {
            status: 'available',
            willingToJoin: true,
          },
          // relay exactly what’s in the schema: startDate/endDate :contentReference[oaicite:0]{index=0}
          expectedWorkDuration: {
            startDate: user.expectedWorkDuration.startDate,
            endDate: user.expectedWorkDuration.endDate,
          },
          hasPassword: hasPassword, // Thêm field này để frontend biết user có thể unlink không
          googleId: user.googleId, // Thêm googleId để frontend biết trạng thái liên kết
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    if (req.body.password || req.body.role) {
      return next(
        new AppError('This route is not for password or role updates.', 400)
      );
    }

    // Only allow these fields
    const allowed = [
      'fullname',
      'username',
      'email',
      'avatar',
      'skills',
      'about',
      'experience',
      'yearOfExperience',
      'availability',
      'expectedWorkDuration',
    ];
    const filtered = {};
    Object.keys(req.body).forEach((k) => {
      if (allowed.includes(k)) filtered[k] = req.body[k];
    });

    // …email uniqueness checks…

    // 1. Validate skills array of lowercase values
    if (filtered.skills) {
      if (!Array.isArray(filtered.skills)) {
        return next(
          new AppError('Skills must be an array of skill values.', 400)
        );
      }
      for (const val of filtered.skills) {
        const skill = await Skill.findOne({ value: val });
        if (!skill) {
          return next(new AppError(`Skill not found: ${val}`, 404));
        }
      }
    }

    // 2. Validate availability (unchanged) …

    // 3. Validate expectedWorkDuration.startDate/endDate
    if (filtered.expectedWorkDuration) {
      const { startDate, endDate } = filtered.expectedWorkDuration;
      const s = new Date(startDate);
      const e = new Date(endDate);
      if (isNaN(s) || isNaN(e)) {
        return next(new AppError('Invalid start or end date.', 400));
      }
      if (s > e) {
        return next(
          new AppError('Start date must be before or equal to end date.', 400)
        );
      }
    }

    // 4. Perform update
    const updated = await User.findByIdAndUpdate(req.user._id, filtered, {
      new: true,
      runValidators: true,
    }).select('-password -passwordResetToken -passwordResetExpires');

    if (!updated) {
      return next(new AppError('User not found.', 404));
    }

    // 5. Return in same shape as getProfile
    res.status(200).json({
      status: 'success',
      data: {
        user: {
          id: updated._id,
          fullname: updated.fullname || '',
          username: updated.username || '',
          email: updated.email,
          role: updated.role,
          avatar: updated.avatar || null,
          skills: updated.skills || [],
          about: updated.about || '',
          experience: updated.experience || '',
          yearOfExperience: updated.yearOfExperience || 0,
          availability: updated.availability || {
            status: 'available',
            willingToJoin: true,
          },
          expectedWorkDuration: {
            startDate: updated.expectedWorkDuration.startDate,
            endDate: updated.expectedWorkDuration.endDate,
          },
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, passwordConfirm } = req.body;

    if (!currentPassword || !newPassword || !passwordConfirm) {
      return next(new AppError('All three fields are required.', 400));
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
      return next(new AppError('User not found.', 404));
    }

    const isMatch = await user.correctPassword(currentPassword, user.password);
    if (!isMatch) {
      return next(new AppError('Your current password is incorrect.', 401));
    }

    if (newPassword !== passwordConfirm) {
      return next(new AppError('New passwords do not match.', 400));
    }

    user.password = newPassword;
    user.passwordChangedAt = Date.now();
    await user.save();

    const token = require('jsonwebtoken').sign(
      { _id: user._id },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN,
      }
    );
    res.status(200).json({ status: 'success', token });
  } catch (err) {
    next(err);
  }
};

exports.deactivateMe = async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      isDeleted: true,
      deletedAt: Date.now(),
    });
    res.status(204).json({ status: 'success', data: null });
  } catch (err) {
    next(err);
  }
};

exports.findUsersByEmails = async (req, res, next) => {
  try {
    const { emails } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Email list is required and must be an array.',
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = emails.filter((email) => !emailRegex.test(email));

    if (invalidEmails.length > 0) {
      return res.status(400).json({
        status: 'error',
        message: `Email is invalid: ${invalidEmails.join(', ')}`,
      });
    }

    const currentUserEmail = req.user.email;
    const selfInvite = emails.includes(currentUserEmail);

    if (selfInvite) {
      return res.status(400).json({
        status: 'error',
        message: 'You cannot invite yourself.',
      });
    }

    const users = await User.find({
      email: { $in: emails },
      isDeleted: false,
    }).select('_id email username fullname');

    const foundEmails = users.map((user) => user.email);
    const notFoundEmails = emails.filter(
      (email) => !foundEmails.includes(email)
    );

    res.status(200).json({
      status: 'success',
      data: {
        foundUsers: users.map((user) => ({
          userId: user._id,
          email: user.email,
          username: user.username,
          fullname: user.fullname || '',
        })),
        notFoundEmails,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.getAllUsers = async (req, res, next) => {
  try {
    if (req.user.role !== 'adminSystem') {
      return next(new AppError('Admin access required.', 403));
    }

    const users = await User.find({ isDeleted: false })
      .select('-password -passwordResetToken -passwordResetExpires')
      .populate('skills');

    res.status(200).json({
      status: 'success',
      results: users.length,
      data: {
        users: users.map((u) => ({
          id: u._id,
          fullname: u.fullname || '',
          username: u.username || '',
          email: u.email,
          role: u.role,
          skills: u.skills || [],
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateUserById = async (req, res, next) => {
  try {
    if (req.user.role !== 'adminSystem') {
      return next(new AppError('Admin access required.', 403));
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new AppError('Invalid user ID format.', 400));
    }

    if (
      id === req.user._id.toString() &&
      req.body.role &&
      req.body.role !== 'adminSystem'
    ) {
      return next(new AppError('You cannot change your own role.', 400));
    }

    const allowedFields = ['role', 'isDeleted'];
    const filteredBody = {};
    Object.keys(req.body).forEach((key) => {
      if (allowedFields.includes(key)) {
        filteredBody[key] = req.body[key];
      }
    });

    const updatedUser = await User.findByIdAndUpdate(id, filteredBody, {
      new: true,
      runValidators: true,
    })
      .select('-password -passwordResetToken -passwordResetExpires')
      .populate('skills');

    if (!updatedUser) {
      return next(new AppError('User not found.', 404));
    }

    res.status(200).json({
      status: 'success',
      data: {
        user: {
          id: updatedUser._id,
          fullname: updatedUser.fullname || '',
          username: updatedUser.username || '',
          email: updatedUser.email,
          role: updatedUser.role,
          isDeleted: updatedUser.isDeleted,
          skills: updatedUser.skills || [],
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteUserById = async (req, res, next) => {
  try {
    if (req.user.role !== 'adminSystem') {
      return next(new AppError('Admin access required.', 403));
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new AppError('Invalid user ID format.', 400));
    }

    const user = await User.findById(id);
    if (!user) {
      return next(new AppError('User not found.', 404));
    }

    if (user.role === 'adminSystem') {
      return next(new AppError('Cannot delete another admin user.', 400));
    }

    await User.findByIdAndDelete(id);
    res
      .status(200)
      .json({ status: 'success', message: 'User deleted successfully.' });
  } catch (err) {
    next(err);
  }
};

exports.getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new AppError('Invalid user ID.', 400));
    }

    const user = await User.findById(id)
      .select('-password -passwordResetToken -passwordResetExpires')
      .populate('skills');

    if (!user) {
      return next(new AppError('User not found.', 404));
    }

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user._id,
          fullname: user.fullname || '',
          username: user.username || '',
          email: user.email,
          role: user.role,
          avatar: user.avatar || null,
          skills: user.skills || [],
          about: user.about || '',
          experience: user.experience || '',
          yearOfExperience: user.yearOfExperience || 0,
          availability: user.availability || {
            status: 'available',
            willingToJoin: true,
          },
          expectedWorkDuration: user.expectedWorkDuration || {
            min: 0,
            max: 0,
            unit: 'hours',
          },
          createdAt: user.createdAt,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};
