import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import mongoose from "mongoose";
import { User } from "../models/User";

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      callbackURL: process.env.GOOGLE_CALLBACK_URL ?? "",
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        let user = await User.findOne({ googleId: profile.id });
        if (!user) {
          const email = profile.emails?.[0]?.value ?? `${profile.id}@oauth.placeholder`;
          user = await User.create({
            googleId: profile.id,
            email,
            name: profile.displayName ?? "User",
            avatar: profile.photos?.[0]?.value,
            role: "USER",
          });
        }

        done(null, {
          _id: user._id as mongoose.Types.ObjectId,
          googleId: user.googleId,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          role: user.role,
        });
      } catch (err) {
        done(err as Error);
      }
    }
  )
);

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
      googleId: user.googleId,
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
