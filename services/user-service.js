'use strict';

const request = require('request');
const config = require('../config');

module.exports = {

  addUser: function(callback, userId) {
    request({
      uri: 'https://graph.facebook.com/v3.1/' + userId,
      qs: {
        access_token: config.FB_PAGE_TOKEN
      }

    }, function(error, response, body) {
      if (!error && response.statusCode == 200) {
        var user = JSON.parse(body);
        if (user.first_name.length > 0) {
          // var pool = new pg.Pool(config.PG_CONFIG);
          // pool.connect(function(err, client, done) {
          //   if (err) {
          //     return console.error('Error acquiring client', err.stack);
          //   }
          //   var rows = [];
          //   client.query(`SELECT fb_id FROM users WHERE fb_id='${userId}' LIMIT 1`,
          //     function(err, result) {
          //       if (err) {
          //         console.log('Query error: ' + err);
          //       } else {
          //
          //         if (result.rows.length === 0) {
          //           let sql = 'INSERT INTO users (fb_id, first_name, last_name, profile_pic, ' +
          //             'locale, timezone, gender) VALUES ($1, $2, $3, $4, $5, $6, $7)';
          //           client.query(sql,
          //               [
          //                   userId,
          //                   user.first_name,
          //                   user.last_name,
          //                   user.profile_pic,
          //                   user.locale,
          //                   user.timezone,
          //                   user.gender
          //               ]);
          //         }
          //       }
          //     });
          //
          //   callback(user);
          // });
          // pool.end();
        } else {
          console.log("Cannot get data for fb user with id",
            userId);
        }
      } else {
        console.error(response.error);
      }
    });
  }

};
