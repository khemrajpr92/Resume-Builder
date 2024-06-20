require("dotenv").config({ path: __dirname + "/.env" });

const express = require("express");
const bodyParser = require("body-parser");
const pdf = require("html-pdf");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const path = require("path");

const pdfTemplate = require("./documents");

const app = express();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const MONGO_URI = process.env.MONGO_URI;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const mongoClient = new MongoClient(MONGO_URI);

let DB;
mongoClient
  .connect()
  .then((client) => {
    console.log("Connected to MongoDB!");
    DB = client.db("resumebuilder");
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });

const options = {
  height: "42cm",
  width: "35.7cm",
  timeout: "6000",
  childProcessOptions: {
    env: {
      OPENSSL_CONF: "/dev/null",
    },
  },
};

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "/public")));

const verifyGoogleToken = async (token) => {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    return { payload: ticket.getPayload() };
  } catch (error) {
    console.error("Error verifying Google token:", error);
    return { error: "Invalid user detected. Please try again", e: error };
  }
};

app.post("/verifyToken", (req, res) => {
  const token = req.body.token;
  jwt.verify(token, GOOGLE_CLIENT_SECRET, (err, decodedToken) => {
    if (err) {
      return res.status(401).json({
        message: "Token verification failed",
        error: err,
      });
    }

    const email = decodedToken?.email;
    DB.collection("users")
      .findOne({ email })
      .then((user) => {
        if (!user) {
          return res.status(400).json({
            message: "You are not registered. Please sign up",
          });
        } else if (Date.now() < decodedToken.exp * 1000) {
          return res.status(200).json({ status: "Success" });
        }
      })
      .catch((err) => {
        console.error("Error finding user:", err);
        res.status(500).json({ message: "Internal server error" });
      });
  });
});

app.post("/signup", async (req, res) => {
  try {
    const { credential } = req.body;
    if (credential) {
      const verificationResponse = await verifyGoogleToken(credential);
      if (verificationResponse.error) {
        return res.status(400).json({
          message: verificationResponse.error,
        });
      }

      const profile = verificationResponse.payload;
      const user = {
        firstName: profile.given_name,
        lastName: profile.family_name,
        picture: profile.picture,
        email: profile.email,
        token: jwt.sign({ email: profile.email }, GOOGLE_CLIENT_SECRET, {
          expiresIn: "1d",
        }),
      };

      DB.collection("users")
        .insertOne(user)
        .then((resp) => {
          res.status(201).json({
            message: "Signup was successful",
            user,
          });
        })
        .catch((err) => {
          console.error("Error inserting user:", err);
          res.status(500).json({
            message: "An error occurred. Registration failed.",
            error: err,
          });
        });
    }
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({
      message: "An error occurred. Registration failed.",
      error,
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { credential } = req.body;
    if (credential) {
      const verificationResponse = await verifyGoogleToken(credential);
      if (verificationResponse.error) {
        return res.status(400).json({
          message: verificationResponse.error,
        });
      }

      const profile = verificationResponse.payload;
      DB.collection("users")
        .findOne({ email: profile.email })
        .then((user) => {
          if (!user) {
            return res.status(400).json({
              message: "You are not registered. Please sign up",
            });
          }

          DB.collection("resume")
            .findOne({ userid: user._id.toString() })
            .then((resumeDoc) => {
              res.status(201).json({
                message: "Login was successful",
                resume: resumeDoc,
                user: {
                  firstName: profile.given_name,
                  lastName: profile.family_name,
                  picture: profile.picture,
                  email: profile.email,
                  token: jwt.sign(
                    { email: profile.email },
                    GOOGLE_CLIENT_SECRET,
                    { expiresIn: "1d" }
                  ),
                },
              });
            })
            .catch((err) => {
              console.error("Error finding resume:", err);
              res.status(500).json({ message: "Internal server error" });
            });
        })
        .catch((err) => {
          console.error("Error finding user:", err);
          res.status(500).json({ message: "Internal server error" });
        });
    }
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      message: "An error occurred. Login failed.",
      error: err,
    });
  }
});

app.post("/save", (req, res) => {
  const { user, resume } = req.body;
  delete resume.step;

  DB.collection("users")
    .findOne({ email: user.email })
    .then((userDoc) => {
      const USERID = userDoc._id.toString();
      const data = { userid: USERID, ...resume };

      DB.collection("resume")
        .findOne({ userid: USERID })
        .then((resumeDoc) => {
          if (resumeDoc) {
            DB.collection("resume")
              .deleteOne({ userid: USERID })
              .then(() => {
                DB.collection("resume")
                  .insertOne(data)
                  .then(() => res.sendStatus(200))
                  .catch((err) => {
                    console.error("Error inserting resume:", err);
                    res.status(500).json({ message: "Internal server error" });
                  });
              })
              .catch((err) => {
                console.error("Error deleting resume:", err);
                res.status(500).json({ message: "Internal server error" });
              });
          } else {
            DB.collection("resume")
              .insertOne(data)
              .then(() => res.sendStatus(200))
              .catch((err) => {
                console.error("Error inserting resume:", err);
                res.status(500).json({ message: "Internal server error" });
              });
          }
        })
        .catch((err) => {
          console.error("Error finding resume:", err);
          res.status(500).json({ message: "Internal server error" });
        });
    })
    .catch((err) => {
      console.error("Error finding user:", err);
      res.status(500).json({ message: "Internal server error" });
    });
});

app.post("/get-resume", (req, res) => {
  const { email } = req.body;
  DB.collection("users")
    .findOne({ email })
    .then((userDoc) => {
      const USERID = userDoc._id.toString();
      DB.collection("resume")
        .findOne({ userid: USERID })
        .then((resumeDoc) => {
          if (resumeDoc) {
            delete resumeDoc._id;
            delete resumeDoc.userid;
            res.send(resumeDoc);
          }
        })
        .catch((err) => {
          console.error("Error finding resume:", err);
          res.status(500).json({ message: "Internal server error" });
        });
    })
    .catch((err) => {
      console.error("Error finding user:", err);
      res.status(500).json({ message: "Internal server error" });
    });
});

app.post("/create-pdf", (req, res) => {
  pdf.create(pdfTemplate(req.body), options).toFile("Resume.pdf", (err) => {
    if (err) {
      console.error("Error creating PDF:", err);
      res.send(Promise.reject());
    } else {
      res.send(Promise.resolve());
    }
  });
});

app.get("/", (req, res) => {
  res.send("Hello from 'Resume Builder' Web App");
});

app.get("/fetch-pdf", (req, res) => {
  const file = `${__dirname}/Resume.pdf`;
  res.download(file);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
