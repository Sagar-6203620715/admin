
import mongoose, { Schema, Document, Types } from 'mongoose'

// Address Sub-Schema
export const addressSchema = new Schema({
  type: { type: String, enum: ['billing', 'shipping'], required: true },
  street: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
  zipCode: { type: String, required: true },
  country: { type: String, required: true },
  phone: { type: String, required: false },
})

// OrderItem Sub-Schema
export const orderItemSchema = new Schema({
  product_id: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, required: true, default: 0 },
  Ah_Rating_Selected: { type: Number, default: 0 },
  Voltage_Rating_Selected: { type: Number, default: 0 },
  Kw_Rating: { type: Number, default: 0 },
  Price: { type: Number, required: true, default: 0 },
})

// Document Uploads Sub-Schema
const documentUploadSchema = new Schema({
  aadhar: {
    type: String,
    required: false,
    validate: {
      validator: (v: string | undefined) => !v || /^\d{12}$/.test(String(v).trim()),
      message: "AADHAR must be exactly 12 digits",
    },
  },
  pan: {
    type: String,
    required: false,
    validate: {
      validator: (v: string | undefined) => {
        if (!v) return true
        const val = String(v).trim().toUpperCase()
        return /^\d{10}$/.test(val) || /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(val)
      },
      message: "PAN must be exactly 10 characters",
    },
  },
  gstin: { type: String, required: false },
})

export interface OrderItem {
  product_id: Types.ObjectId
  quantity: number
  Ah_Rating_Selected?: number
  Voltage_Rating_Selected?: number
  Kw_Rating?: number
  Price: number
}

export interface Address {
  type: 'billing' | 'shipping'
  street: string
  city: string
  state: string
  zipCode: string
  country: string
  phone?: string
}

export interface DocumentUpload {
  aadhar?: string,
  pan?: string,
  // panOrAadhar?: string
  gstin?: string
}

export interface IUser extends Document {
  name: string
  email: string
  password: string
  userType: 'individual' | 'reseller' | 'oem'
  isVerified?:Boolean
  addresses: Address[]
  order: Types.ObjectId[]
  documents?: DocumentUpload
  createdAt: Date
  updatedAt: Date
}

const userSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isVerified:{type:Boolean ,default:false},
  userType: { type: String, enum: ['individual', 'reseller', 'oem'], required: true, default: 'individual' },
  addresses: { type: [addressSchema], default: [] },
  order: { type: [{type:Schema.Types.ObjectId}], ref: 'Order', default: [] },
  documents: {
    type: documentUploadSchema,
    default: {},
    required: true,
    validate: {
      validator: function (this: any, v: { aadhar?: string; pan?: string } | undefined) {
        // Individuals don't provide documents
        if (this.userType === "individual") return true;
        return Boolean(
          v &&
            ((v.aadhar && String(v.aadhar).trim()) ||
              (v.pan && String(v.pan).trim())),
        );
      },
      message: "Either AADHAR or PAN is required",
    },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

userSchema.pre<IUser>('save', function (next) {
  this.updatedAt = new Date()
  next()
})

export const User = mongoose.models.User || mongoose.model<IUser>('User', userSchema)

