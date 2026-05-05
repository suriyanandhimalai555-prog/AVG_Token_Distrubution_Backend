import type mongoose from "mongoose";

declare global {
  namespace Express {
    interface User {
      _id: mongoose.Types.ObjectId;
      googleId: string;
      email: string;
      name: string;
      avatar?: string;
      role: "USER" | "ADMIN";
    }
  }
}

export {};
