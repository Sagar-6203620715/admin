
import { NextResponse } from "next/server";
import { Resend } from "resend";
import chromium from '@sparticuz/chromium';
import type { PuppeteerNode ,Browser} from "puppeteer-core";
import fs from "fs";
import path from "path";
import { dbConnect } from "../../../../models/dbconnect";
import { User } from "../../../../models/user";
import { Order } from "../../../../models/order";

let puppeteer: PuppeteerNode;
const isProduction = process.env.NODE_ENV === "production";

// Asset paths
const templatePath = path.join(process.cwd(), "templates", "proforma-invoice.html");
const logoPath = path.join(process.cwd(), "public", "images", "ELECTROCHEM-LOGO-1 (1).svg");

// Module caching
let cachedTemplate: string | null = null;
let cachedLogo: string | null = null;

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
  let browser:Browser | null= null;

  try {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      return NextResponse.json({ message: "RESEND_API_KEY missing." }, { status: 500 });
    }

    const resend = new Resend(resendApiKey);
    await dbConnect();

    const body = (await req.json()) as {
      items: CartItemInput[];
      email: string;
      orderId: string;
      discount: number;
    };

    const { items, email, orderId, discount } = body;

    // 1. Fetch User & Order in Parallel
    const [user, order] = await Promise.all([
      User.findOne({ email }),
      Order.findById(orderId)
    ]);

    if (!order || !user) {
      return NextResponse.json({ message: "Order or User not found." }, { status: 404 });
    }

    
    if (!cachedTemplate) {
      cachedTemplate = fs.readFileSync(templatePath, "utf8");
    }
    if (!cachedLogo && fs.existsSync(logoPath)) {
      const logoContent = fs.readFileSync(logoPath, "utf8");
      cachedLogo = `data:image/svg+xml;utf8,${encodeURIComponent(logoContent)}`;
    }

    // 3. GST & Tax Logic
    const primaryAddress = user?.addresses?.[0];
    const userState = primaryAddress?.state?.toLowerCase().trim() || "";
    const isUP = userState === "uttar pradesh" || userState === "up";

    let sgst:number = 0, cgst:number = 0, igst:number = 0, subtotal:number = 0;

    for (const item of items) {
      const itemSubtotal = item.quantity * item.price;
      const isCharger = ["charger", "chargers"].includes(item.category.toLowerCase().trim());

      if (isUP) {
        const rate = isCharger ? 0.025 : 0.09;
        sgst += itemSubtotal * rate;
        cgst += itemSubtotal * rate;
      } else {
        const rate = isCharger ? 0.05 : 0.18;
        igst += itemSubtotal * rate;
      }
      subtotal += itemSubtotal;
    }

    const totalAmount = subtotal + cgst + sgst + igst - (discount || 0);

    
    const now = new Date();
    const piNumber = `PI-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${Math.floor(1000 + Math.random() * 9000)}`;
    const validUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString();

    const processedItems = items.map((item) => ({
      productName: item.productName || "Item",
      quantity: Number(item.quantity) || 1,
      unitPrice: Number(item.price) || 0,
      totalPrice: (Number(item.price) || 0) * (Number(item.quantity) || 1),
    }));
    const itemsHtml = processedItems.map((item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${item.productName}</td>
        <td>8507</td> <td>${validUntil}</td>
        <td class="text-right font-bold">${item.quantity} PCS</td>
        <td class="text-right">${item.unitPrice.toFixed(2)}</td>
        <td>PCS</td>
        <td class="text-right font-bold">${(item.unitPrice * item.quantity).toFixed(2)}</td>
      </tr>
    `).join("");

    const html = cachedTemplate!
      .replace(/{{logoUrl}}/g, cachedLogo || "")
      .replace(/{{piNumber}}/g, piNumber)
      .replace(/{{issueDate}}/g, now.toLocaleDateString())
      .replace(/{{validUntil}}/g, validUntil)
      .replace(/{{customerName}}/g, user.name || "Valued Customer")
      .replace(/{{customerAddress}}/g, `${primaryAddress?.street}, ${primaryAddress?.city}, ${primaryAddress?.state}`)
      .replace(/{{customerPhone}}/g, primaryAddress?.phone || "N/A")
      .replace(/{{customerGSTIN}}/g, user.documents?.gstin || "URD")
      .replace(/{{customerState}}/g, primaryAddress?.state || "N/A")
      .replace(/{{subtotal}}/g, subtotal.toFixed(2))
      .replace(/{{discount}}/g, (discount || 0).toFixed(2))
      .replace(/{{cgstAmount}}/g, cgst.toFixed(2))
      .replace(/{{sgstAmount}}/g, sgst.toFixed(2))
      .replace(/{{igstAmount}}/g, igst.toFixed(2))
      .replace(/{{totalAmount}}/g, totalAmount.toFixed(2))
      .replace(/{{items}}/g, itemsHtml);

    // 5. PDF Generation
    const binPath=path.join(process.cwd(),'node_modules/@sparticuz/chromium/bin')
    browser = await puppeteer.launch({
      args: isProduction ? chromium.args : ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: isProduction ? await chromium.executablePath(binPath) : undefined,
      headless: true,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });

    // 6. Send Email
    const {data:emailResult, error: emailError } = await resend.emails.send({
      from: "sales@electrochembattery.com",
      to: "bhardwajashish701@gmail.com",
      subject: `Proforma Invoice ${piNumber} - ElectroChem`,
      html: `<p>Dear ${user.name},</p><p>Please find attached your Proforma Invoice <strong>${piNumber}</strong>.</p>`,
      attachments: [{ content: Buffer.from(pdfBuffer), filename: `${piNumber}.pdf` }],
    });

   if (emailError) {
      console.error("Resend API Error:", emailError);
      return NextResponse.json(
        { message: "Failed to send invoice email." },
        { status: 502 },
      );
    }

    // 7. Finalize Order Status
    await Order.findByIdAndUpdate(orderId, { isEmailSent: true });

    return NextResponse.json({ message: "Invoice sent successfully." }, { status: 201 });

  } catch (err) {
    console.error("Invoice Error:", err);
    let errorMessage:string = "Internal Server Error";
    if(err instanceof Error){
      errorMessage = err.message;
    }
    return NextResponse.json({ message: errorMessage }, { status: 500 });
  } finally {
    if (browser) await browser.close();
  }
}
