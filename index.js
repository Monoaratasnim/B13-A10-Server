const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const Stripe = require("stripe");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

// ================= STRIPE =================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ================= MIDDLEWARE =================
app.use(cors());

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("❌ Webhook Error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const ebookId = session.metadata.ebookId;
      const userEmail = session.metadata.userEmail;

      try {
        const ebook = await ebookCollection.findOne({
          _id: new ObjectId(ebookId),
        });

        await purchaseCollection.updateOne(
          {
            ebookId: new ObjectId(ebookId),
            userEmail,
          },
          {
            $setOnInsert: {
              ebookId: new ObjectId(ebookId),

              userEmail,

              writerEmail: ebook.writerEmail,
              writerName: ebook.writerName,

              ebookTitle: ebook.title,

              amount: session.amount_total / 100,

              paymentIntent: session.payment_intent,
              stripeSessionId: session.id,

              status: "paid",

              createdAt: new Date(),
            },
          },
          {
            upsert: true,
          }
        );

        await ebookCollection.updateOne(
          {
            _id: new ObjectId(ebookId),
          },
          {
            $set: {
              sold: true,
            },
          }
        );

        console.log("✅ Purchase saved:", userEmail);
      } catch (err) {
        console.log("❌ Database Error:", err);
      }
    }

    res.json({
      received: true,
    });
  }
);

app.use(express.json());

// ================= DB =================
const client = new MongoClient(process.env.MONGODB_URI);
const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
);

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        msg: "Unauthorized",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        msg: "Unauthorized",
      });
    }

    const { payload } = await jwtVerify(token, JWKS);

    req.user = payload;

    next();
  } catch (error) {
    console.log(error);

    return res.status(401).json({
      msg: "Unauthorized",
    });
  }
};

let ebookCollection;
let userCollection;
let purchaseCollection;

// ================= CONNECT DB =================
async function run() {
  try {
    // await client.connect();
    const db = client.db("fable");

    ebookCollection = db.collection("ebooks");
    userCollection = db.collection("user");
    purchaseCollection = db.collection("purchases");

    console.log("MongoDB Connected");
  } catch (error) {
    console.log(error);
  }
}
run();

// ================= HOME =================
app.get("/", (req, res) => {
  res.send("Fable Server Running...");
});

// ================= GET EBOOKS =================
app.get("/api/ebooks", async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 8;
    const skip = (page - 1) * limit;

    const query = {};

    if (req.query.search) {
      query.title = {
        $regex: req.query.search,
        $options: "i",
      };
    }

    if (req.query.genre && req.query.genre !== "all") {
      query.genre = req.query.genre;
    }

    if (req.query.availability === "available") {
      query.sold = false;
    }

    if (req.query.availability === "sold") {
      query.sold = true;
    }

    if (req.query.minPrice || req.query.maxPrice) {
      query.price = {};
      if (req.query.minPrice) query.price.$gte = Number(req.query.minPrice);
      if (req.query.maxPrice) query.price.$lte = Number(req.query.maxPrice);
    }

    let cursor = ebookCollection.find(query);

    if (req.query.sort === "new") cursor = cursor.sort({ createdAt: -1 });
    if (req.query.sort === "low") cursor = cursor.sort({ price: 1 });
    if (req.query.sort === "high") cursor = cursor.sort({ price: -1 });

    const total = await ebookCollection.countDocuments(query);
    const ebooks = await cursor.skip(skip).limit(limit).toArray();

    res.send({
      ebooks,
      totalPages: Math.ceil(total / limit),
      total,
    });
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch ebooks" });
  }
});

app.get("/api/ebooks/featured", async (req, res) => {
  try {
    const ebooks = await ebookCollection
      .find({ published: true })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.send(ebooks);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch featured ebooks",
    });
  }
});
// =============== SINGLE EBOOK ===============
app.get("/api/ebooks/:id", async (req, res) => {
  try {
    const ebook = await ebookCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!ebook) {
      return res.status(404).send({ message: "Ebook not found" });
    }

    res.send(ebook);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch ebook" });
  }
});


// ================ CHECK PURCHASE =================
app.get("/api/check-purchase", async (req, res) => {
  try {
    const { ebookId, email } = req.query;

    if (!ebookId || !email) {
      return res.status(400).send({ purchased: false });
    }

    const purchase = await purchaseCollection.findOne({
      ebookId: new ObjectId(ebookId),
      userEmail: email,
    });

    res.send({ purchased: !!purchase });
  } catch (error) {
    res.status(500).send({ purchased: false });
  }
});

// ================ BOOKMARK TOGGLE ================
app.patch("/api/bookmarks", verifyToken, async (req, res) => {
  try {
    const { email, ebookId } = req.body;

    let user = await userCollection.findOne({ email });

    if (!user) {
      await userCollection.insertOne({
        email,
        bookmarks: [ebookId],
        createdAt: new Date(),
      });

      return res.send({ bookmarked: true });
    }

    const exists = (user.bookmarks || []).includes(ebookId);

    if (exists) {
      await userCollection.updateOne(
        { email },
        { $pull: { bookmarks: ebookId } }
      );
      return res.send({ bookmarked: false });
    }

    await userCollection.updateOne(
      { email },
      { $addToSet: { bookmarks: ebookId } }
    );

    res.send({ bookmarked: true });
  } catch (error) {
    res.status(500).send({ message: "Bookmark failed" });
  }
});

// =============== GET BOOKMARKS ===============
app.get("/api/my-bookmarks", verifyToken, async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) return res.send([]);

    const user = await userCollection.findOne({ email });

    if (!user?.bookmarks?.length) return res.send([]);

    const ids = user.bookmarks.map((id) => new ObjectId(id));

    const ebooks = await ebookCollection
      .find({ _id: { $in: ids } })
      .toArray();

    res.send(ebooks);
  } catch (error) {
    res.status(500).send([]);
  }
});

// ============= CREATE STRIPE CHECKOUT =============
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { ebookId, userEmail } = req.body;

    const ebook = await ebookCollection.findOne({
      _id: new ObjectId(ebookId),
    });

    if (!ebook) {
      return res.status(404).send({ message: "Ebook not found" });
    }

    if (ebook.writerEmail === userEmail) {
      return res.status(400).send({
        message: "Writer cannot buy own ebook",
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: ebook.title,
              description: ebook.description,
            },
            unit_amount: Math.round(Number(ebook.price) * 100),
          },
          quantity: 1,
        },
      ],

      success_url: `${process.env.CLIENT_URL}/ebooks/${ebookId}?success=true`,
      cancel_url: `${process.env.CLIENT_URL}/ebooks/${ebookId}?canceled=true`,

      metadata: {
        ebookId: String(ebookId),
        userEmail: String(userEmail),
      },
    });

    res.send({ url: session.url });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Stripe error" });
  }
});

// ================= ADD EBOOK =================
app.post("/api/ebooks",verifyToken, async (req, res) => {
  try {
    const ebook = req.body;

    const result = await ebookCollection.insertOne({
      ...ebook,
      sold: false,
      published: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.send({
      success: true,
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.log(error);

    res.status(500).send({
      success: false,
      message: "Failed to create ebook",
    });
  }
});

// ================= WRITER EBOOKS =================
app.get("/api/writer/ebooks",verifyToken, async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) {
      return res.status(400).send({
        message: "Writer email required",
      });
    }

    const ebooks = await ebookCollection
      .find({
        writerEmail: email,
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    res.send(ebooks);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch ebooks",
    });
  }
});

// ================= GET SINGLE EBOOK =================
app.get("/api/writer/ebooks/:id",verifyToken, async (req, res) => {
  try {
    const ebook = await ebookCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!ebook) {
      return res.status(404).send({
        message: "Ebook not found",
      });
    }

    res.send(ebook);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch ebook",
    });
  }
});

// ================= UPDATE EBOOK =================
app.put("/api/writer/ebooks/:id",verifyToken, async (req, res) => {
  try {
    const data = req.body;

    const result = await ebookCollection.updateOne(
      {
        _id: new ObjectId(req.params.id),
      },
      {
        $set: {
          title: data.title,
          description: data.description,
          price: Number(data.price),
          genre: data.genre,
          coverImage: data.coverImage,
          updatedAt: new Date(),
        },
      }
    );

    res.send(result);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Update failed",
    });
  }
});

// ================= DELETE EBOOK =================
app.delete("/api/ebooks/:id",verifyToken, async (req, res) => {
  try {
    const result = await ebookCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    res.send(result);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Delete failed",
    });
  }
});

// ================ TOGGLE PUBLISH ================
app.patch("/api/ebooks/:id/publish",verifyToken, async (req, res) => {
  try {
    const { published } = req.body;

    const result = await ebookCollection.updateOne(
      {
        _id: new ObjectId(req.params.id),
      },
      {
        $set: {
          published,
          updatedAt: new Date(),
        },
      }
    );

    res.send(result);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Update failed",
    });
  }
});

// ================= WRITER STATS =================
app.get("/api/writer/stats",verifyToken, async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) {
      return res.status(400).send({
        message: "Writer email required",
      });
    }

    // Writer ebooks
    const ebooks = await ebookCollection
      .find({
        writerEmail: email,
      })
      .toArray();

    const ebookIds = ebooks.map((ebook) => ebook._id);

    // Sales
    const sales = await purchaseCollection
      .find({
        ebookId: {
          $in: ebookIds,
        },
      })
      .toArray();

    const totalEbooks = ebooks.length;
    const totalSales = sales.length;

    const totalRevenue = sales.reduce(
      (sum, item) => sum + (item.amount || 0),
      0
    );

    res.send({
      totalEbooks,
      totalSales,
      totalRevenue,
    });
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to load stats",
    });
  }
});
app.get("/api/top-writers", async (req, res) => {
  try {
    const writers = await purchaseCollection
      .aggregate([
        {
          $lookup: {
            from: "ebooks",
            localField: "ebookId",
            foreignField: "_id",
            as: "ebook",
          },
        },
        {
          $unwind: "$ebook",
        },
        {
          $group: {
            _id: "$ebook.writerEmail",
            writerName: {
              $first: "$ebook.writerName",
            },
            totalSales: {
              $sum: 1,
            },
          },
        },
        {
          $lookup: {
            from: "user",
            localField: "_id",
            foreignField: "email",
            as: "user",
          },
        },
        {
          $unwind: {
            path: "$user",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            writerEmail: "$_id",
            writerName: 1,
            totalSales: 1,
            avatar: "$user.image",
          },
        },
        {
          $sort: {
            totalSales: -1,
          },
        },
        {
          $limit: 3,
        },
      ])
      .toArray();

    res.send(writers);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch top writers",
    });
  }
});
// ================ WRITER SALES HISTORY ================
app.get("/api/writer/sales",verifyToken, async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).send({
        message: "Writer email is required",
      });
    }

    const sales = await purchaseCollection
      .find({
        writerEmail: email,
      })
      .sort({
        createdAt: -1,
      })
      .toArray();

    res.send(sales);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch sales history",
    });
  }
});
   
// ================= ADMIN STATS =================
app.get("/api/admin/stats",verifyToken, async (req, res) => {
  try {
    const totalUsers = await userCollection.countDocuments({
      role: "user",
    });

    const totalWriters = await userCollection.countDocuments({
      role: "writer",
    });

    const totalAdmins = await userCollection.countDocuments({
      role: "admin",
    });

    const totalEbooks = await ebookCollection.countDocuments();

    const totalSold = await purchaseCollection.countDocuments();

    const purchases = await purchaseCollection.find().toArray();

    const totalRevenue = purchases.reduce(
      (sum, item) => sum + (item.amount || 0),
      0
    );

    res.send({
      totalUsers,
      totalWriters,
      totalAdmins,
      totalEbooks,
      totalSold,
      totalRevenue,
    });
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch admin stats",
    });
  }
});
app.get("/api/admin/monthly-sales",verifyToken, async (req, res) => {
  try {
    const purchases = await purchaseCollection.find().toArray();

    const months = {};

    purchases.forEach((item) => {
      const month = new Date(item.createdAt).toLocaleString("default", {
        month: "short",
      });

      months[month] = (months[month] || 0) + Number(item.amount);
    });

    const result = Object.keys(months).map((month) => ({
      month,
      revenue: months[month],
    }));

    res.send(result);
  } catch (err) {
    console.log(err);
    res.status(500).send({ message: "Failed" });
  }
});
app.get("/api/admin/genre-stats",verifyToken, async (req, res) => {
  try {
    const genres = await ebookCollection
      .aggregate([
        {
          $group: {
            _id: "$genre",
            value: {
              $sum: 1,
            },
          },
        },
        {
          $project: {
            _id: 0,
            genre: "$_id",
            value: 1,
          },
        },
      ])
      .toArray();

    res.send(genres);
  } catch (err) {
    console.log(err);
    res.status(500).send({ message: "Failed" });
  }
});
// ================= ADMIN USERS =================
app.get("/api/admin/users",verifyToken, async (req, res) => {
  try {
    const users = await userCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.send(users);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch users",
    });
  }
});
// =============== UPDATE USER ROLE ===============
app.patch("/api/admin/users/:id/role",verifyToken, async (req, res) => {
  try {
    const { role } = req.body;

    const result = await userCollection.updateOne(
      {
        _id: new ObjectId(req.params.id),
      },
      {
        $set: {
          role,
          updatedAt: new Date(),
        },
      }
    );

    res.send(result);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Role update failed",
    });
  }
});
// ================ DELETE USER ================
app.delete("/api/admin/users/:id",verifyToken, async (req, res) => {
  try {
    const result = await userCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    res.send(result);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Delete failed",
    });
  }
});
// =============== ADMIN EBOOKS ===============
app.get("/api/admin/ebooks",verifyToken, async (req, res) => {
  try {
    const ebooks = await ebookCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    res.send(ebooks);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch ebooks",
    });
  }
});
// ================= ADMIN TOGGLE PUBLISH =================
app.patch("/api/admin/ebooks/:id/publish",verifyToken, async (req, res) => {
  try {
    const { published } = req.body;

    const result = await ebookCollection.updateOne(
      {
        _id: new ObjectId(req.params.id),
      },
      {
        $set: {
          published,
          updatedAt: new Date(),
        },
      }
    );

    res.send(result);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Publish update failed",
    });
  }
});
// ================ ADMIN DELETE EBOOK ================
app.delete("/api/admin/ebooks/:id",verifyToken, async (req, res) => {
  try {
    const result = await ebookCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    res.send(result);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Delete failed",
    });
  }
});
// ============= ADMIN TRANSACTIONS =============
app.get("/api/admin/transactions",verifyToken, async (req, res) => {
  try {
    const transactions = await purchaseCollection
      .find()
      .sort({ createdAt: -1 })
      .toArray();

    const formatted = transactions.map((item) => ({
      _id: item._id,
      transactionId: item._id,
      type: "ebook purchase",
      email: item.userEmail,
      amount: item.amount,
      date: item.createdAt,
    }));

    res.send(formatted);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch transactions",
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});