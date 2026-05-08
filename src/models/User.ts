import mongoose, { Document, Schema } from "mongoose";

export interface IUser extends Document {
  email: string;
  name: string;
  avatar?: string;
  passwordHash?: string;
  passwordSalt?: string;
  role: "USER" | "ADMIN";
}

const UserSchema = new Schema<IUser>(
  {
    googleId: { type: String, sparse: true, unique: true },
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    avatar: { type: String },
    passwordHash: { type: String },
    passwordSalt: { type: String },
    role: { type: String, enum: ["USER", "ADMIN"], default: "USER" },
  },
  { timestamps: true }
);

export const User = mongoose.model<IUser>("User", UserSchema);
