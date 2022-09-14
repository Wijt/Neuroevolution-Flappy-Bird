class PlayScene extends Scene {
    constructor() {
        super();
        this.player;
        this.pipes;
        
        this.gameStarted = false;

        this.nextPipe = null;

        this.returnToMenuButton;
    }

    setupUI() {
        this.returnToMenuButton = createButton('<');
        let bottomLeftCorner = createVector();
        this.returnToMenuButton.size(30, 30);
        bottomLeftCorner.x = innerWidth/2 - width/2 + 10;
        bottomLeftCorner.y = innerHeight - (innerHeight - height)/2 - 40;
        this.returnToMenuButton.position(bottomLeftCorner.x, bottomLeftCorner.y);
        this.returnToMenuButton.mousePressed(() => {
            this.sceneManager.openScene(MENU_SCENE);
            this.returnToMenuButton.remove(); //to pervent any bug
        });
    }

    start() {
        super.start();
        
        this.setupUI();

        this.player = new Bird(BIRD_X, 100);

        this.pipes = [];

        let pipeCount = width / (PIPE_BETWEEN + PIPE_WIDTH);
    

        for (let i = 1; i <= pipeCount + 2; i++) {
            new Pipe(width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH), random(PIPE_NO_GAP_ZONE, height-PIPE_NO_GAP_ZONE));
        }
            
        this.gameStarted = true;
    }

    update() {
        super.update();
    
        if (!this.gameStarted) return;

        this.player.update();

        //If the player is dead, don't update the pipes
        if (!this.player.live) return; 
        
        this.pipes.forEach(pipe => {
            pipe.update();
        });

     
        //select next pipe
        this.nextPipe = this.pipes.filter(pipe => pipe.pos.x > this.player.pos.x - (PIPE_WIDTH + BIRD_R))[0];

        if (this.nextPipe != null) {
            // kill the player if hit a pipe
            let hitted = circleRect(this.player, this.nextPipe.topPipe) || circleRect(this.player, this.nextPipe.bottomPipe);
            if (hitted) this.player.live = false;

            // give the player a point if he passed a pipe
            if (this.player.pos.x > this.nextPipe.pos.x && this.nextPipe.hasPoint) {
                this.player.score++;
                this.nextPipe.hasPoint = false;
            }
        }
        
        // check if the player hit the ground
        if (this.player.pos.y > height - GROUND_HEIGHT) {
            this.player.live = false;
        }
    }

    draw() {      
        background(color(BG_COLOR));

        this.pipes.forEach(pipe => {
            pipe.show();
        });
        
        //player should be drawn after the pipes so it's not hidden by them when dieing
        this.player.show(); 
        
        push(); //Ground drawing
            noStroke();
            fill(color(GROUND_COLOR));
            rect(0, height - GROUND_HEIGHT, width, GROUND_HEIGHT);
        pop();

        push(); //Score drawing
            textAlign(CENTER);
            fill(255);
            textSize(60);
            text(this.player.score, width/2, 60);
        pop();
        
        if (!this.player.live) {
            push(); //dead panel background
                fill(0, 0, 0, 255 * 0.70);
                rect(0, 0, width, height);
            pop();

            push();
                textAlign(CENTER);
                fill(255);
                textSize(60);
                text("Game Over", width/2, height/2);

                textSize(30);
                text("Click to restart", width/2, height/2 + 40);

                textSize(20);
                text("Score: " + this.player.score, width/2, height/2 + 80);
            pop();
        }
    }

    mouseReleased() {
        if (this.player.live){
            this.player.jump();
        }else{
            this.start();
        }
    }
}