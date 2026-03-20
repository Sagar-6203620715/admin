
import { NextResponse } from "next/server";
import { Resend } from "resend";

import chromium from "@sparticuz/chromium-min";
import type { PuppeteerNode } from "puppeteer-core";
import fs from "fs";
import path from "path";
import { dbConnect } from "../../../../models/dbconnect";
import { User } from "../../../../models/user";
import { Order } from "../../../../models/order";

let puppeteer: PuppeteerNode;
const resend = new Resend(process.env.RESEND_API_KEY!);

const isProduction = process.env.NODE_ENV === "production";

if (isProduction) {
  const mod = await import("puppeteer-core");
  puppeteer = mod.default;
} else {
  const mod = await import("puppeteer");
  puppeteer = (mod as unknown as { default: PuppeteerNode }).default;
}

interface CartItemInput {
  id?: string;
  productName: string;
  quantity: number;
  category: string;
  price: number;
}

export async function POST(req: Request) {
  try {
    await dbConnect();

    const body = (await req.json()) as {
      items: CartItemInput[];
      email: string;
      orderId: string;
      discount: number;
    };

    const { items, email, orderId, discount } = body;

    if (!items || items.length === 0) {
      return NextResponse.json(
        { message: "Cart is empty. Cannot generate invoice." },
        { status: 400 },
      );
    }

    if (!email) {
      return NextResponse.json(
        { message: "Customer email is required." },
        { status: 400 },
      );
    }
    if (!orderId) {
      return NextResponse.json(
        { message: "Order ID is required to link the invoice." },
        { status: 400 },
      );
    }
    const user = await User.findOne({ email });
    const order = await Order.findById(orderId);
    if (!order) {
      return NextResponse.json(
        { message: "Order not found." },
        { status: 404 },
      );
    }
    if (!user) {
      return NextResponse.json(
        { message: "User not found for the provided email." },
        { status: 404 },
      );
    }

    // Prepare line items for invoice
    const processedItems = items.map((item) => ({
      productName: item.productName || "Item",
      quantity: Number(item.quantity) || 1,
      unitPrice: Number(item.price) || 0,
      totalPrice: (Number(item.price) || 0) * (Number(item.quantity) || 1),
    }));

    const primaryAddress = user?.addresses?.[0];
    const userState = primaryAddress?.state?.toLowerCase().trim() || " ";
    const isUP = userState === "uttar pradesh" || userState === "up";

    let sgst: number = 0;
    let cgst: number = 0;
    let igst: number = 0;
    let subtotal: number = 0;
    for (const item of items) {
      const isCharger: boolean =
        item.category.toLowerCase().trim() === "charger" ||
        item.category.toLowerCase().trim() === "chargers";
      const itemSubtotal: number = item.quantity * item.price;

      if (isUP && isCharger) {
        sgst += itemSubtotal * 0.025;
        cgst += itemSubtotal * 0.025;
      } else if (isUP && !isCharger) {
        sgst += itemSubtotal * 0.09;
        cgst += itemSubtotal * 0.09;
      } else if (!isUP && isCharger) {
        igst += itemSubtotal * 0.05;
      } else if (!isUP && !isCharger) {
        igst += itemSubtotal * 0.18;
      }
      subtotal += itemSubtotal;
    }
    // Calculate totals (same tax structure as template: CGST + SGST)

    // const taxRate = 18; // 18% total GST
    // const cgstRate = taxRate / 2; // 9%
    // const sgstRate = taxRate / 2; // 9%
    const cgstAmount = cgst;
    const sgstAmount = sgst;
    const igstAmount = igst;

    const totalAmount =
      subtotal + cgstAmount + sgstAmount + igstAmount - discount;

    // Generate PI number
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const random = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    const piNumber = `PI-${year}${month}-${random}`;

    // Load HTML template
    let templatePath = path.join(
      process.cwd(),
      "templates",
      "proforma-invoice.html",
    );
    if (!fs.existsSync(templatePath)) {
      // Fallback if project root differs
      templatePath = path.resolve(
        process.cwd(),
        "electrochem-store",
        "templates",
        "proforma-invoice.html",
      );
    }

    if (!fs.existsSync(templatePath)) {
      console.error("Template not found at", templatePath);
      return NextResponse.json(
        { message: "Invoice template file not found." },
        { status: 500 },
      );
    }

    const template = fs.readFileSync(templatePath, "utf8");

    // Load logo as data URL (fallback to empty if missing)
    const logoPath = path.join(
      process.cwd(),
      "public",
      "images",
      "ELECTROCHEM-LOGO-1 (1).svg",
    );
    let logoDataUrl = "";
    if (fs.existsSync(logoPath)) {
      const logoContent = fs.readFileSync(logoPath, "utf8");
      logoDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(logoContent)}`;
    }

    // Build items rows HTML
    const validUntil = new Date(
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    ).toLocaleDateString();

    const itemsHtml = processedItems
      .map(
        (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${item.productName}</td>
        <td>39173290</td>
        <td>${validUntil}</td>
        <td class="text-right font-bold">${item.quantity} PCS</td>
        <td class="text-right">${item.unitPrice.toFixed(2)}</td>
        <td>PCS</td>
        <td class="text-right font-bold">${item.totalPrice.toFixed(2)}</td>
      </tr>
    `,
      )
      .join("");

    // Extract address info from user
    // const primaryAddress = user.addresses?.[0];

    const customerName = user.name || "Valued Customer";
    const customerAddress =
      primaryAddress &&
      `${primaryAddress.street}, ${primaryAddress.city}, ${primaryAddress.state} ${primaryAddress.zipCode}, ${primaryAddress.country}`;
    const customerPhone = primaryAddress?.phone || "";
    const customerGSTIN = user.documents?.gstin || "GSTIN not provided";
    const customerState = primaryAddress?.state || "State not provided";

    // Simple variable replacement in template
    const html = template
      .replace(/{{logoUrl}}/g, logoDataUrl)
      .replace(/{{piNumber}}/g, piNumber)
      .replace(/{{issueDate}}/g, now.toLocaleDateString())
      .replace(/{{validUntil}}/g, validUntil)
      .replace(/{{customerName}}/g, customerName)
      .replace(
        /{{customerAddress}}/g,
        customerAddress || "Address not provided",
      )
      .replace(/{{customerPhone}}/g, customerPhone || "Phone not provided")
      .replace(/{{customerGSTIN}}/g, customerGSTIN)
      .replace(/{{customerState}}/g, customerState)
      .replace(/{{subtotal}}/g, subtotal.toFixed(2))
      .replace(/{{discount}}/g, discount.toFixed(2))
      .replace(/{{cgstAmount}}/g, cgstAmount.toFixed(2))
      .replace(/{{sgstAmount}}/g, sgstAmount.toFixed(2))
      .replace(/{{igstAmount}}/g, igstAmount.toFixed(2))
      .replace(/{{totalAmount}}/g, totalAmount.toFixed(2))
      .replace(/{{notes}}/g, "")
      .replace(/{{items}}/g, itemsHtml);

    // Generate PDF in memory using Puppeteer

    let cachedExecutablePath: string | undefined;

    async function getExecutablePath() {
      if (cachedExecutablePath) return cachedExecutablePath;

      if (process.env.NODE_ENV === "production") {
        
        cachedExecutablePath = await chromium.executablePath(
          `${process.env.NEXT_PUBLIC_BASE_URL}/chromium/chromium-pack.tar`,
        );
      } else {
        
        cachedExecutablePath = undefined;
      }

      return cachedExecutablePath;
    }
    const browser = await puppeteer.launch({
      args: isProduction ? chromium.args : [],
      executablePath: await getExecutablePath(),
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "10mm",
        right: "10mm",
        bottom: "10mm",
        left: "10mm",
      },
    });

    await browser.close();

    // Send email with PDF attachment via Resend using the generated buffer
    const { data: emailResult, error } = await resend.emails.send({
      from: "sales@electrochembattery.com",
      to: "bhardwajashish601@gmail.com",
      subject: `Proforma Invoice ${piNumber} - ElectroChem`,
      html: `<p>Dear ${customerName},</p>
             <p>Thank you for your order. Please find attached the Proforma Invoice <strong>${piNumber}</strong>.</p>
             <p>Best regards,<br/>ElectroChem Power</p>`,
      attachments: [
        {
          // Send the in-memory buffer directly as a Node Buffer
          content: Buffer.from(pdfBuffer),
          filename: `${piNumber}.pdf`,
        },
      ],
    });

    if (error) {
      console.error("Resend API Error:", error);
      return NextResponse.json(
        { message: "Failed to send invoice email." },
        { status: 502 },
      );
    }

    // Mark order as placed if orderId provided
    if (orderId) {
      try {
        await Order.findByIdAndUpdate(orderId, { isEmailSent: true });
      } catch (e) {
        console.error("Failed to update order status to placed:", e);
      }
    }

    return NextResponse.json(
      {
        message: "Invoice email sent successfully.",
        data: emailResult,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error("Error generating or sending invoice:", err);
    return NextResponse.json(
      { message: "Internal Server Error." },
      { status: 500 },
    );
  }
}

