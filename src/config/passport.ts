import passport from "passport";
import mongoose from "mongoose";
import { User } from "../models/User";

passport.serializeUser((user: Express.User, done) => {
  done(null, user._id.toString());
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await User.findById(id).lean();
    if (!user) {
      done(null, false);
      return;
    }
    done(null, {
      _id: user._id as mongoose.Types.ObjectId,
      googleId: user.googleId ?? undefined,
      email: user.email,
      name: user.name,
      avatar: user.avatar ?? undefined,
      role: user.role,
    });
  } catch (err) {
    done(err);
  }
});

export default passport;
