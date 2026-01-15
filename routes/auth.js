const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashedPassword });
    res.json({ status: true, user });
  } catch (ex) {
    res.json({ status: false, msg: ex.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.json({ status: false, msg: "Incorrect Username" });
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.json({ status: false, msg: "Incorrect Password" });
    delete user.password;
    res.json({ status: true, user });
  } catch (ex) {
    res.json({ status: false, msg: ex.message });
  }
});

module.exports = router;