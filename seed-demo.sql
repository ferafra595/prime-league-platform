INSERT OR IGNORE INTO teams (id,name,slug,short_name,primary_color,secondary_color,manager_name,coach_name) VALUES
(1,'Prime United','prime-united','PUN','#7c3cff','#ffffff','Marco Rossi','Luca Bianchi'),
(2,'Mesoraca FC','mesoraca-fc','MES','#e11d48','#ffffff','Andrea Greco','Paolo Costa'),
(3,'Black Eagles','black-eagles','BEA','#111827','#fbbf24','Franco Gallo','Michele Serra'),
(4,'Royal Seven','royal-seven','ROY','#0ea5e9','#ffffff','Antonio Leone','Salvatore Rizzo');

INSERT OR IGNORE INTO players (team_id,first_name,last_name,slug,shirt_number,role) VALUES
(1,'Davide','Rossi','davide-rossi',9,'Attaccante'),
(1,'Lorenzo','Bianchi','lorenzo-bianchi',10,'Centrocampista'),
(2,'Matteo','Greco','matteo-greco',7,'Attaccante'),
(2,'Simone','Costa','simone-costa',1,'Portiere'),
(3,'Alessio','Gallo','alessio-gallo',11,'Attaccante'),
(4,'Giuseppe','Leone','giuseppe-leone',8,'Centrocampista');

INSERT OR IGNORE INTO matches (id,season_id,round_name,home_team_id,away_team_id,match_date,venue,status,home_score,away_score) VALUES
(1,1,'1ª Giornata',1,2,'2026-09-12T20:30:00','Campo Prime Arena','published',3,2),
(2,1,'1ª Giornata',3,4,'2026-09-13T20:30:00','Campo Prime Arena','published',1,1),
(3,1,'2ª Giornata',1,3,'2026-09-19T20:30:00','Campo Prime Arena','scheduled',NULL,NULL),
(4,1,'2ª Giornata',2,4,'2026-09-20T20:30:00','Campo Prime Arena','scheduled',NULL,NULL);

INSERT OR IGNORE INTO match_events (match_id,team_id,player_id,assist_player_id,event_type,quantity) VALUES
(1,1,1,2,'goal',2),(1,1,2,NULL,'goal',1),(1,2,3,NULL,'goal',2),(1,2,4,NULL,'yellow',1),
(2,3,5,NULL,'goal',1),(2,4,6,NULL,'goal',1);

INSERT OR IGNORE INTO sponsors (name,level,is_featured) VALUES ('Main Partner Prime League','league',1);
INSERT OR IGNORE INTO news (title,slug,excerpt,body,is_published,published_at) VALUES
('Nasce la Prime League','nasce-la-prime-league','Il calcio del territorio entra in una nuova dimensione.','Benvenuti nella piattaforma ufficiale della Prime League. Qui troverete risultati, classifiche, squadre, giocatori e votazioni.',1,CURRENT_TIMESTAMP);
