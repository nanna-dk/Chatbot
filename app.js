'use strict';

const dialogflow = require('dialogflow');
const config = require('./config');
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const request = require('request');
const app = express();
const uuid = require('uuid');

//const broadcast = require('./routes/broadcast');
//const webviews = require('./routes/webviews');

const userService = require('./services/user-service');
let dialogflowService = require('./services/dialogflow-service');
const fbService = require('./services/fb-service');

const passport = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;
const session = require('express-session');

// Messenger API parameters
if (!config.FB_PAGE_TOKEN) {
  throw new Error('missing FB_PAGE_TOKEN');
}
if (!config.FB_VERIFY_TOKEN) {
  throw new Error('missing FB_VERIFY_TOKEN');
}
if (!config.GOOGLE_PROJECT_ID) {
  throw new Error('missing GOOGLE_PROJECT_ID');
}
if (!config.DF_LANGUAGE_CODE) {
  throw new Error('missing DF_LANGUAGE_CODE');
}
if (!config.GOOGLE_CLIENT_EMAIL) {
  throw new Error('missing GOOGLE_CLIENT_EMAIL');
}
if (!config.GOOGLE_PRIVATE_KEY) {
  throw new Error('missing GOOGLE_PRIVATE_KEY');
}
if (!config.FB_APP_SECRET) {
  throw new Error('missing FB_APP_SECRET');
}
if (!config.SERVER_URL) { //used for link to static files
  throw new Error('missing SERVER_URL');
}
if (!config.ADMIN_ID) { //admin id for facebook login
  throw new Error('missing ADMIN_ID');
}

app.set('port', (process.env.PORT || 5000))

//verify request came from facebook
app.use(bodyParser.json({verify: fbService.verifyRequestSignature}));

//serve static files in the public directory
app.use(express.static('public'));

// Process application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({extended: false}));

// Process application/json
app.use(bodyParser.json());

app.use(session({secret: 'keyboard cat', resave: true, saveUninitilized: true}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser(function(profile, cb) {
  cb(null, profile);
});

passport.deserializeUser(function(profile, cb) {
  cb(null, profile);
});

passport.use(new FacebookStrategy({
  clientID: config.FB_APP_ID,
  clientSecret: config.FB_APP_SECRET,
  callbackURL: config.SERVER_URL + "auth/facebook/callback"
}, function(accessToken, refreshToken, profile, cb) {
  process.nextTick(function() {
    return cb(null, profile);
  });
}));

app.get('/auth/facebook', passport.authenticate('facebook', {scope: 'public_profile'}));

// app.get('/auth/facebook/callback', passport.authenticate('facebook', {
//   successRedirect: '/broadcast/broadcast',
//   failureRedirect: '/broadcast'
// }));
//
// app.set('view engine', 'ejs');

const credentials = {
  client_email: config.GOOGLE_CLIENT_EMAIL,
  private_key: config.GOOGLE_PRIVATE_KEY
};

const sessionClient = new dialogflow.SessionsClient({projectId: config.GOOGLE_PROJECT_ID, credentials});
const sessionIds = new Map();
const usersMap = new Map();

// Index route
app.get('/', function(req, res) {
  res.send('Hello world, I am a chat bot')
})

//app.use('/broadcast', broadcast);
//app.use('/webviews', webviews);

// for Facebook verification
app.get('/webhook/', function(req, res) {
  console.log("request");
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.FB_VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
})

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook/', function(req, res) {
  var data = req.body;
  console.log(JSON.stringify(data));

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          fbService.receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          fbService.receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          fbService.receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          fbService.receivedAccountLink(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    // You must send back a 200, within 20 seconds
    res.sendStatus(200);
  }
});

function setSessionAndUser(senderID) {
  if (!sessionIds.has(senderID)) {
    sessionIds.set(senderID, uuid.v1());
  }

  if (!usersMap.has(senderID)) {
    userService.addUser(function(user) {
      usersMap.set(senderID, user);
    }, senderID);
  }
}

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  setSessionAndUser(senderID);

  //console.log("Received message for user %d and page %d at %d with message:", senderID, recipientID, timeOfMessage);
  //console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    fbService.handleEcho(messageId, appId, metadata);
    return;
  } else if (quickReply) {
    handleQuickReply(senderID, quickReply, messageId);
    return;
  }

  if (messageText) {
    //send message to DialogFlow
    dialogflowService.sendTextQueryToDialogFlow(sessionIds, handleDialogFlowResponse, senderID, messageText);
  } else if (messageAttachments) {
    fbService.handleMessageAttachments(messageAttachments, senderID);
  }
}

function handleQuickReply(senderID, quickReply, messageId) {
  var quickReplyPayload = quickReply.payload;
  switch (quickReplyPayload) {
      // case 'NEWS_PER_WEEK':
      //     userService.newsletterSettings(function (updated) {
      //         if (updated) {
      //             fbService.sendTextMessage(senderID, "Thank you for subscribing!" +
      //                 "If you want to usubscribe just write 'unsubscribe from newsletter'");
      //         } else {
      //             fbService.sendTextMessage(senderID, "Newsletter is not available at this moment." +
      //                 "Try again later!");
      //         }
      //     }, 1, senderID);
      //     break;
      // case 'NEWS_PER_DAY':
      //     userService.newsletterSettings(function (updated) {
      //         if (updated) {
      //             fbService.sendTextMessage(senderID, "Thank you for subscribing!" +
      //                 "If you want to usubscribe just write 'unsubscribe from newsletter'");
      //         } else {
      //             fbService.sendTextMessage(senderID, "Newsletter is not available at this moment." +
      //                 "Try again later!");
      //         }
      //     }, 2, senderID);
      //     break;
    default:
      dialogflowService.sendTextQueryToDialogFlow(sessionIds, handleDialogFlowResponse, senderID, quickReplyPayload);
      break;
  }
}

function handleDialogFlowAction(sender, action, messages, contexts, parameters) {
  switch (action) {
    case "two-answers":
      fbService.handleMessages(messages, sender);
      fbService.sendTypingOn(sender);
      //ask what user wants to do next
      console.log("Asking a conditional question...");
      setTimeout(function() {
        let buttons = [
          {
            type: "postback",
            title: "Dyret",
            payload: "ANSWER_ONE"
          }, {
            type: "postback",
            title: "Pengesedlen",
            payload: "ANSWER_TWO"
          }
        ];
        fbService.sendButtonMessage(sender, "Hvilken slags hund mener du?", buttons);
      }, 3000)
      break;
    case "faq-delivery":
      fbService.handleMessages(messages, sender);
      fbService.sendTypingOn(sender);

      //ask what user wants to do next
      setTimeout(function() {
        let buttons = [
          {
            type: "web_url",
            url: "https://www.myapple.com/track_order",
            title: "Track my order"
          }, {
            type: "phone_number",
            title: "Call us",
            payload: "+16505551234"
          }
        ];

        fbService.sendButtonMessage(sender, "What would you like to do next?", buttons);
      }, 3000)
      break;
    default:
      //unhandled action, just send back the text
      fbService.handleMessages(messages, sender);
  }
}

function handleMessages(messages, sender) {
  let timeoutInterval = 1100;
  let previousType;
  let cardTypes = [];
  let timeout = 0;
  for (var i = 0; i < messages.length; i++) {

    if (previousType == "card" && (messages[i].message != "card" || i == messages.length - 1)) {
      timeout = (i - 1) * timeoutInterval;
      setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
      cardTypes = [];
      timeout = i * timeoutInterval;
      setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
    } else if (messages[i].message == "card" && i == messages.length - 1) {
      cardTypes.push(messages[i]);
      timeout = (i - 1) * timeoutInterval;
      setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
      cardTypes = [];
    } else if (messages[i].message == "card") {
      cardTypes.push(messages[i]);
    } else {

      timeout = i * timeoutInterval;
      setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
    }
    previousType = messages[i].message;
  }
}

function handleDialogFlowResponse(sender, response) {
  let responseText = response.fulfillmentMessages.fulfillmentText;
  let messages = response.fulfillmentMessages;
  let action = response.action;
  let contexts = response.outputContexts;
  let parameters = response.parameters;

  fbService.sendTypingOff(sender);

  if (fbService.isDefined(action)) {
    handleDialogFlowAction(sender, action, messages, contexts, parameters);
  } else if (fbService.isDefined(messages)) {
    fbService.handleMessages(messages, sender);
  } else if (responseText == '' && !fbService.isDefined(action)) {
    //dialogflow could not evaluate input.
    fbService.sendTextMessage(sender, "Hej. Jeg er ikke sikker på at jeg forstår. prøv igen.");
  } else if (fbService.isDefined(responseText)) {
    fbService.sendTextMessage(sender, responseText);
  }
}

async function resolveAfterXSeconds(x) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(x);
    }, x * 1000);
  });
}

async function greetUserText(userId) {
  let user = usersMap.get(userId);
  if (!user) {
    await resolveAfterXSeconds(2);
    user = usersMap.get(userId);
  }
  fbService.sendTextMessage(userId, "Hej " + user.first_name + '! ' + 'Jeg kan svare på det meste - hvad kan jeg hjælpe dig med?');
}

/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  setSessionAndUser(senderID);

  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  var payload = event.postback.payload;

  switch (payload) {
    case 'ANSWER_ONE':
      //fbService.sendTextMessage(senderID, "Kæledyr forbudt!");
      setTimeout(function() {
        let buttons = [
          {
            type: "web_url",
            url: "https://www.google.dk",
            title: "Læs mere om hunde på google..."
          }
        ];
        fbService.sendButtonMessage(senderID, "Læs mere om hunden.", buttons);
      }, 3000)
      break;
    case 'ANSWER_TWO':
      //fbService.sendTextMessage(senderID, "Ingen penge!");
      setTimeout(function() {
        let buttons = [
          {
            type: "web_url",
            url: "https://www.google.dk",
            title: "Læs mere om pengesedler på google..."
          }
        ];
        fbService.sendButtonMessage(senderID, "Læs mere om penge.", buttons);
      }, 3000)
      break;
    case 'JOB_APPLY':
      //get feedback with new jobs
      dialogflowService.sendEventToDialogFlow(sessionIds, handleDialogFlowResponse, senderID, 'JOB_OPENINGS');
      break;
    default:
      //unindentified payload
      fbService.sendTextMessage(senderID, "Hvad kan jeg hjælpe med?");
      break;
  }

  console.log("Received postback for user %d and page %d:-) with payload '%s' " + "at %d", senderID, recipientID, payload, timeOfPostback);
}

// Spin up the server
app.listen(app.get('port'), function() {
  console.log('running on port', app.get('port'))
})
