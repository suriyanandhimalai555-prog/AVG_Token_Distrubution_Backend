import mongoose, { Document, Schema } from "mongoose";

export interface IUser extends Document {
  googleId: string;
  email: string;
  name: string;
  avatar?: string;
  role: "USER" | "ADMIN";
}

const UserSchema = new Schema<IUser>(
  {
    googleId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    avatar: { type: String },
    role: { type: String, enum: ["USER", "ADMIN"], default: "USER" },
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>("User", UserSchema);
